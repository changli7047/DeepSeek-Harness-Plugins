#!/usr/bin/env python3
"""Archivist Phase 2 ML sidecar.

Protocol (docs/p2-contract.md §1): one JSON request per stdin line, one JSON response
per stdout line, UTF-8.  All human-readable logging goes to stderr; stdout carries
protocol lines only.

Requests:
  {"id":1,"method":"ping","params":{}}
  {"id":2,"method":"embed","params":{"texts":["..."],"model":"e5-small","kind":"passage"}}
  {"id":3,"method":"rerank","params":{"query":"...","docs":["..."],"topK":10}}

Models load lazily on first use, run on CPUExecutionProvider only (DirectML measured
30x slower on this host), and may be unloaded after an idle period.  There is no
network access and no download: a missing model is a readable MODEL_MISSING error.

Run:      python -m archivist_ml.sidecar
Selfcheck: python -m archivist_ml.sidecar --selftest   (also works as ml/sidecar.py)
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import signal
import sys
import threading
import time
import traceback

PKG_VERSION = '0.2.0'
LOG_PREFIX = '[archivist-ml]'

# Hard input caps: a malformed/hostile request must not OOM the sidecar.
_MAX_TEXTS = 256
_MAX_TEXTS_CHARS = 2_000_000
_MAX_DOCS = 256
_MAX_SEQ = 512
_ONNX_RELPATHS = ('onnx/model_int8.onnx', 'onnx/model.onnx', 'model_int8.onnx', 'model.onnx')
_DEFAULT_EMBED_MODEL = 'e5-small'
_DEFAULT_RERANK_MODEL = 'bge-reranker-base'
# Imported once at startup, before the stdin reader thread exists.  Importing numpy's
# C extension from inside a request handler (while that thread blocks on the stdin pipe)
# deadlocked on this host; eager import costs ~0.25s and removes the failure mode.
_RUNTIME = {'np': None, 'ort': None, 'Tokenizer': None, 'error': None}
_TIMEOUT_EMBED_MS = 5000
_TIMEOUT_RERANK_MS = 15000


class MlError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _log(message: str) -> None:
    try:
        sys.stderr.write(f'{LOG_PREFIX} {message}\n')
        sys.stderr.flush()
    except Exception:  # stderr closed: never fail a request because logging failed
        pass


def _env(name: str, default: str = '') -> str:
    value = os.environ.get(name)
    return value.strip() if isinstance(value, str) and value.strip() else default


def _env_int(name: str, default: int, low: int, high: int) -> int:
    raw = _env(name)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


def _models_dir() -> str:
    configured = _env('ARCHIVIST_ML_MODELS')
    if configured:
        return os.path.abspath(configured)
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .../ml
    return os.path.join(os.path.dirname(here), '.index', 'models')


def _rss_mb():
    """Working-set size in MB, stdlib only (no psutil dependency)."""
    try:
        import ctypes
        from ctypes import wintypes

        class _ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ('cb', wintypes.DWORD),
                ('PageFaultCount', wintypes.DWORD),
                ('PeakWorkingSetSize', ctypes.c_size_t),
                ('WorkingSetSize', ctypes.c_size_t),
                ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                ('QuotaPagedPoolUsage', ctypes.c_size_t),
                ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                ('PagefileUsage', ctypes.c_size_t),
                ('PeakPagefileUsage', ctypes.c_size_t),
            ]

        counters = _ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(_ProcessMemoryCounters)
        kernel32 = ctypes.windll.kernel32
        # Prototypes matter: without restype=HANDLE the pseudo-handle (-1) is truncated
        # to 32 bits on 64-bit Windows and GetProcessMemoryInfo fails with 0.
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        for dll in (ctypes.windll.psapi, kernel32):
            get_info = getattr(dll, 'GetProcessMemoryInfo', None) or getattr(dll, 'K32GetProcessMemoryInfo', None)
            if get_info is None:
                continue
            get_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessMemoryCounters), wintypes.DWORD]
            get_info.restype = wintypes.BOOL
            if get_info(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
                return round(counters.WorkingSetSize / 1048576.0, 1)
    except Exception:
        pass
    try:
        import resource

        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0, 1)
    except Exception:
        return None


def _find_model_file(model_dir: str, predicate) -> str:
    if not os.path.isdir(model_dir):
        raise MlError('MODEL_MISSING', f'model directory not found: {model_dir} '
                                      f'(set ARCHIVIST_ML_MODELS or run the download step in ml/README.md)')
    for rel in _ONNX_RELPATHS:
        candidate = os.path.join(model_dir, rel)
        if predicate(candidate):
            return candidate
    for root, _dirs, files in os.walk(model_dir):
        for name in files:
            candidate = os.path.join(root, name)
            if predicate(candidate):
                return candidate
    return ''


def _find_onnx(model_dir: str) -> str:
    path = _find_model_file(model_dir, lambda p: p.lower().endswith('.onnx'))
    if not path:
        raise MlError('MODEL_MISSING', f'no .onnx model under {model_dir} '
                                      f'(expected onnx/model_int8.onnx)')
    return path


def _find_tokenizer(model_dir: str) -> str:
    path = _find_model_file(model_dir, lambda p: os.path.basename(p).lower() == 'tokenizer.json')
    if not path:
        raise MlError('MODEL_MISSING', f'no tokenizer.json under {model_dir}')
    return path


class _Encoder:
    """A sentence-transformers style bi-encoder: mean pooling + L2 normalisation."""

    kind = 'embed'
    max_tokens_env = 'ARCHIVIST_ML_EMBED_MAX_TOKENS'
    default_max_tokens = _MAX_SEQ

    def __init__(self, model: str):
        self.model = model
        self.model_dir = os.path.join(_models_dir(), model)
        self.tok = None
        self.sess = None
        self.input_names: list[str] = []

    def load(self) -> None:
        if self.sess is not None:
            return
        t0 = time.time()
        np = _RUNTIME['np']
        ort = _RUNTIME['ort']
        Tokenizer = _RUNTIME['Tokenizer']
        if np is None or ort is None or Tokenizer is None:
            raise MlError('RUNTIME_MISSING', f"python ML runtime incomplete: {_RUNTIME['error']} "
                                             f'(pip install -r ml/requirements.txt)')
        tokenizer_path = _find_tokenizer(self.model_dir)
        onnx_path = _find_onnx(self.model_dir)
        max_tokens = _env_int(self.max_tokens_env, self.default_max_tokens, 16, _MAX_SEQ)
        _log(f'loading {self.kind} model {self.model}: tokenizer={tokenizer_path} onnx={onnx_path}')
        tokenizer = Tokenizer.from_file(tokenizer_path)
        tokenizer.enable_truncation(max_length=max_tokens)
        _log(f'{self.model}: tokenizer ready (max_tokens={max_tokens})')
        try:
            session = ort.InferenceSession(
                onnx_path,
                providers=['CPUExecutionProvider'],
                sess_options=self._session_options(ort),
            )
        except Exception as err:
            raise MlError('MODEL_LOAD_FAILED', f'cannot load {onnx_path}: {err}') from err
        self.np = np
        self.tok = tokenizer
        self.sess = session
        self.input_names = [i.name for i in session.get_inputs()]
        self.onnx_path = onnx_path
        self.providers = list(session.get_providers())
        self.max_tokens = max_tokens
        self.dim = None
        _log(f'loaded {self.kind} model {self.model} file={os.path.basename(onnx_path)} '
             f'providers={self.providers} max_tokens={max_tokens} in {round((time.time() - t0) * 1000)}ms')

    @staticmethod
    def _session_options(ort):
        options = ort.SessionOptions()
        # CPU provider only: this host's DirectML path measured 30x slower.
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        return options

    def _feed(self, encodings):
        np = self.np
        length = max(len(e.ids) for e in encodings)
        ids = np.zeros((len(encodings), length), dtype=np.int64)
        mask = np.zeros((len(encodings), length), dtype=np.int64)
        types = np.zeros((len(encodings), length), dtype=np.int64)
        for row, enc in enumerate(encodings):
            n = len(enc.ids)
            ids[row, :n] = enc.ids
            mask[row, :n] = enc.attention_mask
            types[row, :n] = enc.type_ids
        available = {'input_ids': ids, 'attention_mask': mask, 'token_type_ids': types}
        return {name: available[name] for name in self.input_names if name in available}

    def embed(self, texts, kind: str = 'passage'):
        self.load()
        np = self.np
        prefix = {'query': 'query: ', 'passage': 'passage: '}.get(kind or '', '')
        encodings = self.tok.encode_batch([prefix + t for t in texts])
        output = self.sess.run(None, self._feed(encodings))[0]
        output = np.asarray(output, dtype=np.float32)
        if output.ndim == 3:
            mask = np.zeros(output.shape[:2], dtype=np.float32)
            for row, enc in enumerate(encodings):
                n = min(len(enc.ids), mask.shape[1])
                mask[row, :n] = 1.0
            weights = mask[:, :, None]
            pooled = (output * weights).sum(axis=1) / np.clip(weights.sum(axis=1), 1e-9, None)
        elif output.ndim == 2:
            pooled = output
        else:
            raise MlError('MODEL_BAD_OUTPUT', f'unexpected embedding output rank {output.ndim}')
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        pooled = pooled / np.clip(norms, 1e-9, None)
        self.dim = int(pooled.shape[1])
        return [[round(float(x), 6) for x in row] for row in pooled]


class _Ranker(_Encoder):
    """bge-reranker style cross-encoder: pair input -> one logit -> sigmoid.

    Reranking pays encoding+forward cost per *candidate*, and on this CPU cost grows
    super-linearly with padded length.  Measured on bge-reranker-base int8, 30 real pairs:
    max 512 -> ~179ms/pair (this was the Phase-3 blocker), max 160 -> ~42ms/pair,
    max 128 -> ~32ms/pair.  Therefore: default truncation 128 tokens, batches of 8 with
    dynamic padding to the longest pair in each batch, session/tokenizer reused.
    """

    kind = 'rerank'
    max_tokens_env = 'ARCHIVIST_ML_RERANK_MAX_TOKENS'
    default_max_tokens = 128

    def score(self, query: str, docs, max_tokens=None, batch_size=None):
        self.load()
        np = self.np
        limit = self.max_tokens if max_tokens is None else max(16, min(_MAX_SEQ, int(max_tokens)))
        size = batch_size if batch_size else _env_int('ARCHIVIST_ML_RERANK_BATCH', 8, 1, 32)
        if limit != self.max_tokens:
            self.tok.enable_truncation(max_length=limit)
        try:
            scores = [0.0] * len(docs)
            for start in range(0, len(docs), size):
                part = docs[start:start + size]
                encodings = [self.tok.encode(query, doc) for doc in part]
                raw = np.asarray(self.sess.run(None, self._feed(encodings))[0], dtype=np.float64)
                if raw.ndim == 2 and raw.shape[1] == 1:
                    logits = raw[:, 0]
                elif raw.ndim == 2:
                    logits = raw[:, 1]
                else:
                    logits = raw.reshape(raw.shape[0], -1)[:, 0]
                for offset, value in enumerate(logits):
                    scores[start + offset] = round(float(1.0 / (1.0 + np.exp(-float(value)))), 6)
            return scores
        finally:
            if limit != self.max_tokens:  # restore the model default (tokenizer state is mutable)
                self.tok.enable_truncation(max_length=self.max_tokens)


_MODELS: dict[str, object] = {}
_LAST_ACTIVITY = time.time()
_IDLE_UNLOAD_S = 600.0


def _preload_runtime() -> bool:
    """Import numpy/onnxruntime/tokenizers once, before the stdin reader thread starts.

    Measured on this host: importing numpy's C extension from inside a request handler
    while that thread is blocked on the stdin pipe deadlocks.  Eager import costs ~0.25s
    and removes the failure mode; model sessions are still loaded lazily.
    """
    if _RUNTIME['np'] is not None:
        return True
    if _RUNTIME['error'] is not None:
        return False
    started = time.time()
    try:
        import numpy as np
        import onnxruntime as ort
        import tokenizers
        from tokenizers import Tokenizer

        _RUNTIME.update(np=np, ort=ort, Tokenizer=Tokenizer)
        _log(f'runtime ready: numpy {np.__version__}, onnxruntime {ort.__version__}, '
             f'tokenizers {tokenizers.__version__} in {round((time.time() - started) * 1000)}ms')
        return True
    except Exception as err:
        _RUNTIME['error'] = f'{type(err).__name__}: {err}'
        _log(f'runtime import failed ({_RUNTIME["error"]}); ping still works, embed/rerank return RUNTIME_MISSING')
        return False


def _has_model(name: str) -> bool:
    """True only when a usable tokenizer + .onnx pair exists: no retries, no waiting."""
    try:
        model_dir = os.path.join(_models_dir(), name)
        _find_tokenizer(model_dir)
        _find_onnx(model_dir)
        return True
    except MlError:
        return False


def _get_model(key: str, factory):
    global _LAST_ACTIVITY
    _LAST_ACTIVITY = time.time()
    model = _MODELS.get(key)
    if model is None:
        model = factory()
        _MODELS[key] = model
        _log(f'registered model {key}')
    return model


def _get_encoder(model_name: str) -> _Encoder:
    key = f'embed:{model_name}'
    encoder = _MODELS.get(key)
    if encoder is None:
        encoder = _get_model(key, lambda: _Encoder(model_name))
    encoder.load()
    return encoder


def _get_ranker(model_name: str) -> _Ranker:
    key = f'rerank:{model_name}'
    ranker = _MODELS.get(key)
    if ranker is None:
        ranker = _get_model(key, lambda: _Ranker(model_name))
    ranker.load()
    return ranker


def _loaded_models() -> list:
    return [key for key, model in _MODELS.items() if getattr(model, 'sess', None) is not None]


def _unload_all() -> None:
    for key in list(_MODELS):
        _MODELS.pop(key, None)
    try:
        import gc

        gc.collect()
    except Exception:
        pass


def _maybe_unload_idle() -> None:
    if _IDLE_UNLOAD_S <= 0 or not _MODELS:
        return
    if time.time() - _LAST_ACTIVITY > _IDLE_UNLOAD_S:
        _log(f'idle {_IDLE_UNLOAD_S:.0f}s: unloading {len(_MODELS)} model(s)')
        _unload_all()


def _check_texts(params) -> list:
    texts = params.get('texts')
    if not isinstance(texts, list) or not texts:
        raise MlError('BAD_PARAMS', 'params.texts must be a non-empty array of strings')
    if len(texts) > _MAX_TEXTS:
        raise MlError('TOO_LARGE', f'too many texts: {len(texts)} > {_MAX_TEXTS}')
    total = 0
    for index, text in enumerate(texts):
        if not isinstance(text, str):
            raise MlError('BAD_PARAMS', f'texts[{index}] is not a string')
        total += len(text)
    if total > _MAX_TEXTS_CHARS:
        raise MlError('TOO_LARGE', f'texts too large: {total} chars > {_MAX_TEXTS_CHARS}')
    return texts


def _handle_embed(params):
    texts = _check_texts(params)
    model = params.get('model') or _env('ARCHIVIST_ML_EMBED_MODEL', _DEFAULT_EMBED_MODEL)
    if not isinstance(model, str):
        raise MlError('BAD_PARAMS', 'params.model must be a string')
    kind = params.get('kind') or 'passage'
    if kind not in ('query', 'passage', 'none'):
        raise MlError('BAD_PARAMS', "params.kind must be 'query', 'passage' or 'none'")
    started = time.time()
    vectors = _get_encoder(model).embed(texts, kind)
    return {
        'model': model,
        'kind': kind,
        'dim': len(vectors[0]),
        'count': len(vectors),
        'vectors': vectors,
        'ms': round((time.time() - started) * 1000, 2),
    }


def _handle_rerank(params):
    query = params.get('query')
    docs = params.get('docs')
    if not isinstance(query, str) or not query.strip():
        raise MlError('BAD_PARAMS', 'params.query must be a non-empty string')
    if not isinstance(docs, list) or not docs:
        raise MlError('BAD_PARAMS', 'params.docs must be a non-empty array of strings')
    if len(docs) > _MAX_DOCS:
        raise MlError('TOO_LARGE', f'too many docs: {len(docs)} > {_MAX_DOCS}')
    for index, doc in enumerate(docs):
        if not isinstance(doc, str):
            raise MlError('BAD_PARAMS', f'docs[{index}] is not a string')
    if _env('ARCHIVIST_ML_RERANK') == '0':
        raise MlError('RERANK_DISABLED', 'rerank is disabled by ARCHIVIST_ML_RERANK=0')
    model = params.get('model') or _env('ARCHIVIST_ML_RERANK_MODEL', _DEFAULT_RERANK_MODEL)
    if not isinstance(model, str):
        raise MlError('BAD_PARAMS', 'params.model must be a string')
    top_k = params.get('topK')
    if top_k is not None and (not isinstance(top_k, int) or isinstance(top_k, bool) or top_k <= 0):
        raise MlError('BAD_PARAMS', 'params.topK must be a positive integer')
    max_tokens = params.get('maxTokens')
    if max_tokens is not None and (not isinstance(max_tokens, int) or isinstance(max_tokens, bool)
                                   or not 16 <= max_tokens <= _MAX_SEQ):
        raise MlError('BAD_PARAMS', f'params.maxTokens must be an integer 16..{_MAX_SEQ}')
    batch = params.get('batch')
    if batch is not None and (not isinstance(batch, int) or isinstance(batch, bool) or not 1 <= batch <= 32):
        raise MlError('BAD_PARAMS', 'params.batch must be an integer 1..32')
    started = time.time()
    ranker = _get_ranker(model)
    scores = ranker.score(query, docs, max_tokens=max_tokens, batch_size=batch)
    pairs = [{'index': index, 'score': score} for index, score in enumerate(scores)]
    pairs.sort(key=lambda pair: pair['score'], reverse=True)
    if top_k:
        pairs = pairs[:top_k]
    return {
        'model': model,
        'scores': pairs,
        'count': len(scores),
        'maxTokens': max_tokens if max_tokens is not None else ranker.max_tokens,
        'batch': batch if batch else _env_int('ARCHIVIST_ML_RERANK_BATCH', 8, 1, 32),
        'ms': round((time.time() - started) * 1000, 2),
    }


def _handle(method, params):
    if method == 'ping':
        return {
            'pid': os.getpid(),
            'version': PKG_VERSION,
            'python': sys.version.split()[0],
            'models_dir': _models_dir(),
            'models_loaded': _loaded_models(),
            'rss_mb': _rss_mb(),
        }
    if method == 'embed':
        return _handle_embed(params)
    if method == 'rerank':
        return _handle_rerank(params)
    raise MlError('UNKNOWN_METHOD', f"unknown method '{method}' (supported: ping, embed, rerank)")


def _respond(payload) -> bool:
    try:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
        sys.stdout.flush()
        return True
    except (BrokenPipeError, OSError):
        return False


def _serve() -> int:
    global _LAST_ACTIVITY, _IDLE_UNLOAD_S
    try:
        _IDLE_UNLOAD_S = float(_env('ARCHIVIST_ML_IDLE_UNLOAD_S', '600'))
    except ValueError:
        _IDLE_UNLOAD_S = 600.0
    requests = queue.Queue()
    stop = threading.Event()

    def _reader():
        try:
            for raw in sys.stdin.buffer:
                requests.put(raw)
        except Exception:
            pass
        requests.put(None)

    def _on_signal(signum, _frame):
        _log(f'signal {signum} received: shutting down')
        stop.set()

    for name in ('SIGTERM', 'SIGINT'):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, _on_signal)
            except (OSError, ValueError):
                pass

    threading.Thread(target=_reader, daemon=True, name='archivist-ml-stdin').start()
    _log(f'sidecar {PKG_VERSION} pid={os.getpid()} ready (models dir: {_models_dir()})')
    while not stop.is_set():
        try:
            raw = requests.get(timeout=0.25)
        except queue.Empty:
            _maybe_unload_idle()
            continue
        if raw is None:
            break  # stdin EOF: graceful shutdown
        line = raw.decode('utf-8', 'replace').strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError('request must be a JSON object')
        except Exception as err:
            _respond({'id': None, 'ok': False,
                      'error': {'code': 'BAD_JSON', 'message': f'invalid JSON request: {err}'}})
            continue
        request_id = request.get('id')
        method = request.get('method')
        params = request.get('params')
        if not isinstance(method, str) or not method:
            _respond({'id': request_id, 'ok': False,
                      'error': {'code': 'BAD_REQUEST', 'message': 'request.method must be a non-empty string'}})
            continue
        if params is None:
            params = {}
        if not isinstance(params, dict):
            _respond({'id': request_id, 'ok': False,
                      'error': {'code': 'BAD_PARAMS', 'message': 'request.params must be an object'}})
            continue
        started = time.time()
        try:
            result = _handle(method, params)
            _LAST_ACTIVITY = time.time()
            if not _respond({'id': request_id, 'ok': True, 'result': result}):
                break
            elapsed_ms = (time.time() - started) * 1000
            budget = _TIMEOUT_RERANK_MS if method == 'rerank' else _TIMEOUT_EMBED_MS
            if method in ('embed', 'rerank') and elapsed_ms > budget:
                # The ONNX call itself cannot be preempted; the host enforces the deadline
                # by killing this process.  Make the slow call visible on stderr.
                _log(f'slow request: method={method} took {elapsed_ms:.0f}ms > host budget {budget}ms')
        except MlError as err:
            _respond({'id': request_id, 'ok': False,
                      'error': {'code': err.code, 'message': err.message}})
        except Exception as err:  # one bad request must never kill the sidecar
            _log('internal error: ' + traceback.format_exc().replace('\n', ' | '))
            _respond({'id': request_id, 'ok': False,
                      'error': {'code': 'INTERNAL', 'message': f'{type(err).__name__}: {err}'}})
    _log('shutting down (unloading models)')
    _unload_all()
    return 0


# ---------------------------------------------------------------- self test

class _LineReader:
    def __init__(self, stream):
        self.queue = queue.Queue()
        self.thread = threading.Thread(target=self._pump, args=(stream,), daemon=True)
        self.thread.start()

    def _pump(self, stream):
        try:
            for line in stream:
                self.queue.put(line)
        except Exception:
            pass
        self.queue.put(None)

    def read(self, timeout):
        return self.queue.get(timeout=timeout)


def _selftest() -> int:
    import subprocess

    results = []

    def check(name, ok, detail=''):
        results.append((name, bool(ok), detail))
        print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))
        sys.stdout.flush()

    try:
        sys.stdout.reconfigure(line_buffering=True)  # progress must be visible through a pipe
    except Exception:
        pass
    models_dir = _models_dir()
    print(f'{LOG_PREFIX} selftest: models_dir={models_dir} python={sys.version.split()[0]}', flush=True)
    embed_model = _env('ARCHIVIST_ML_EMBED_MODEL', _DEFAULT_EMBED_MODEL)
    ranker_model = _env('ARCHIVIST_ML_RERANK_MODEL', _DEFAULT_RERANK_MODEL)
    has_embed = _has_model(embed_model)
    has_rank = _has_model(ranker_model)
    if not has_embed:
        print(f'FAIL embed/rerank: model not found: {os.path.join(models_dir, embed_model)}', flush=True)
        print(f'{LOG_PREFIX} selftest: 0 passed, 1 failed (model missing; set ARCHIVIST_ML_MODELS '
              f'or pass --models-dir)', flush=True)
        return 2
    if not has_rank:
        print(f'SKIP rerank: model not found: {os.path.join(models_dir, ranker_model)}', flush=True)

    deadline = time.time() + 55  # hard cap: --selftest must always finish well under 60s
    env = dict(os.environ)
    env['ARCHIVIST_ML_MODELS'] = models_dir
    env['ARCHIVIST_ML_EMBED_MODEL'] = embed_model
    env['ARCHIVIST_ML_RERANK_MODEL'] = ranker_model
    env['ARCHIVIST_ML_RERANK'] = '1'
    env['ARCHIVIST_ML_IDLE_UNLOAD_S'] = '0'
    cwd = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.Popen(
        [sys.executable, '-m', 'archivist_ml.sidecar'],
        cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding='utf-8', errors='replace', bufsize=1,
    )
    reader = _LineReader(proc.stdout)
    next_id = [0]

    def call(method, params=None, timeout=30):
        remaining = deadline - time.time()
        if remaining <= 1:
            raise RuntimeError(f'selftest deadline exceeded before {method}')
        timeout = min(timeout, remaining)
        next_id[0] += 1
        request_id = next_id[0]
        proc.stdin.write(json.dumps({'id': request_id, 'method': method, 'params': params or {}}) + '\n')
        proc.stdin.flush()
        while True:
            line = reader.read(timeout)
            if line is None:
                raise RuntimeError('sidecar closed stdout')
            line = line.strip()
            if not line:
                continue
            payload = json.loads(line)
            if payload.get('id') == request_id:
                return payload

    def raw(line, timeout=20):
        remaining = deadline - time.time()
        if remaining <= 1:
            raise RuntimeError('selftest deadline exceeded before raw protocol check')
        timeout = min(timeout, remaining)
        proc.stdin.write(line + '\n')
        proc.stdin.flush()
        while True:
            incoming = reader.read(timeout)
            if incoming is None:
                raise RuntimeError('sidecar closed stdout')
            incoming = incoming.strip()
            if not incoming:
                continue
            return json.loads(incoming)

    try:
        ping = call('ping')
        result = ping.get('result') or {}
        check('ping ok, pid/version/rss present',
              ping.get('ok') is True and result.get('pid') and result.get('version') and result.get('rss_mb') is not None,
              f"pid={result.get('pid')} rss_mb={result.get('rss_mb')}")
        check('lazy load: no models before first embed', result.get('models_loaded') == [],
              f"models_loaded={result.get('models_loaded')}")

        bad = raw('this is not json')
        check('bad JSON -> BAD_JSON, not a crash',
              bad.get('ok') is False and (bad.get('error') or {}).get('code') == 'BAD_JSON',
              str((bad.get('error') or {}).get('code')))

        unknown = call('nope')
        check('unknown method -> UNKNOWN_METHOD',
              unknown.get('ok') is False and (unknown.get('error') or {}).get('code') == 'UNKNOWN_METHOD',
              str((unknown.get('error') or {}).get('code')))

        still = call('ping')
        check('alive after bad requests', still.get('ok') is True)

        if has_embed:
            started = time.time()
            embedded = call('embed', {'texts': ['向量检索与余弦相似度', '今天北京天气晴朗'], 'model': embed_model})
            elapsed = round((time.time() - started) * 1000)
            result = embedded.get('result') or {}
            vectors = result.get('vectors') or []
            norm = sum(float(x) * float(x) for x in vectors[0]) ** 0.5 if vectors else 0.0
            check('embed 2 texts: ok, dim 384, unit norm',
                  embedded.get('ok') is True and len(vectors) == 2 and result.get('dim') == 384 and abs(norm - 1.0) < 0.01,
                  f"dim={result.get('dim')} norm={round(norm, 4)} ms={result.get('ms')} first_call={elapsed}ms")

            batch = call('embed', {'texts': [f'批处理块 {i} 全国地表覆盖数据' for i in range(64)], 'model': embed_model})
            check('embed batch of 64 (host batch size)', batch.get('ok') is True and (batch.get('result') or {}).get('count') == 64,
                  f"ms={(batch.get('result') or {}).get('ms')}")

            too_many = call('embed', {'texts': ['x'] * (_MAX_TEXTS + 1), 'model': embed_model})
            check('oversized input -> TOO_LARGE',
                  too_many.get('ok') is False and (too_many.get('error') or {}).get('code') == 'TOO_LARGE',
                  str((too_many.get('error') or {}).get('code')))

            alive = call('ping')
            check('alive after oversized input', alive.get('ok') is True)
            check('ping reports loaded models after embed',
                  bool((alive.get('result') or {}).get('models_loaded')),
                  str((alive.get('result') or {}).get('models_loaded')))

        if has_embed and has_rank:
            reranked = call('rerank', {
                'query': '向量数据库如何做余弦相似度检索',
                'docs': ['余弦相似度是文本向量检索的常用度量', '今天北京天气晴朗适合出门'],
                'topK': 2,
            })
            scores = (reranked.get('result') or {}).get('scores') or []
            in_range = all(0.0 <= float(s['score']) <= 1.0 for s in scores)
            relevant_wins = len(scores) == 2 and scores[0]['index'] == 0 and float(scores[0]['score']) > float(scores[1]['score'])
            check('rerank ok: sigmoid 0..1, sorted, relevant pair wins',
                  reranked.get('ok') is True and in_range and relevant_wins,
                  f"scores={[s['score'] for s in scores]} ms={(reranked.get('result') or {}).get('ms')}")

            # Phase-3 blocker regression: 30 ~160-token Chinese input blocks, sidecar defaults.
            # Measured warm on this CPU: maxTokens=128 -> ~32ms/pair; 160 -> ~40ms/pair;
            # 512 -> ~179ms/pair (this was the reported 4-5x gap).  The gate uses defaults.
            fill = '全国地表覆盖遥感监测与土地利用变化分析数据' * 12
            perf_docs = [fill[:500] + f'#{i}' for i in range(30)]
            perf_started = time.time()
            perf = call('rerank', {'query': '全国土地利用遥感监测变化', 'docs': perf_docs})
            perf_ms = (time.time() - perf_started) * 1000
            perf_scores = (perf.get('result') or {}).get('scores') or []
            per_pair = perf_ms / 30.0
            check('rerank 30 x 160-token blocks: ≤45ms/pair and ≤1.5s total',
                  perf.get('ok') is True and len(perf_scores) == 30 and per_pair <= 45 and perf_ms <= 1500,
                  f'per_pair={per_pair:.1f}ms total={perf_ms:.0f}ms '
                  f"maxTokens={(perf.get('result') or {}).get('maxTokens')} "
                  f"batch={(perf.get('result') or {}).get('batch')}")

        shutdown_started = time.time()
        proc.stdin.close()
        try:
            code = proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            code = 'timeout'
        check('stdin EOF -> graceful exit (0) within 15s',
              code == 0, f'exit={code} took={round((time.time() - shutdown_started) * 1000)}ms')
    finally:
        if proc.poll() is None:
            proc.kill()
        try:
            stderr_tail = (proc.stderr.read() or '').strip().splitlines()[-6:]
            if stderr_tail and any(not r[1] for r in results):
                print('--- sidecar stderr tail ---')
                for line in stderr_tail:
                    print('  ' + line)
        except Exception:
            pass

    # Termination path: a request the host gives up on is killed by the host.
    proc2 = subprocess.Popen(
        [sys.executable, '-m', 'archivist_ml.sidecar'], cwd=cwd, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding='utf-8', errors='replace', bufsize=1,
    )
    try:
        proc2.stdin.write(json.dumps({'id': 1, 'method': 'ping', 'params': {}}) + '\n')
        proc2.stdin.flush()
        line = proc2.stdout.readline()
        alive_ok = bool(line.strip())
        proc2.terminate()  # host-enforced timeout path: kill the request/process
        try:
            proc2.wait(timeout=10)
            killed = proc2.poll() is not None
        except subprocess.TimeoutExpired:
            proc2.kill()
            killed = True
        check('host timeout path: termination is observable and clean',
              alive_ok and killed, 'per-request deadlines are enforced host-side (ONNX calls are not preemptible)')
    finally:
        if proc2.poll() is None:
            proc2.kill()

    failed = [name for name, ok, _detail in results if not ok]
    passed = len(results) - len(failed)
    print(f'{LOG_PREFIX} selftest: {passed} passed, {len(failed)} failed, {len(results)} total')
    return 1 if failed else 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog='archivist_ml.sidecar', description='Archivist Phase 2 ML sidecar')
    parser.add_argument('--selftest', action='store_true', help='run protocol/model self-checks and exit')
    parser.add_argument('--models-dir', default='', help='override ARCHIVIST_ML_MODELS for this run')
    parser.add_argument('--version', action='store_true', help='print version and exit')
    args = parser.parse_args(argv)
    if args.models_dir:
        os.environ['ARCHIVIST_ML_MODELS'] = args.models_dir
    if args.version:
        print(PKG_VERSION)
        return 0
    if args.selftest:
        return _selftest()
    _preload_runtime()  # before the stdin thread exists: see _preload_runtime docstring
    try:
        return _serve()
    except KeyboardInterrupt:
        _unload_all()
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
