"""轻量后台任务管理器（线程池 + 内存任务表）。

用于把耗时操作（如 FFmpeg 拼接导出）从 HTTP 请求线程里挪到后台执行：
  - submit(kind, worker) 立即返回 job_id；worker 在后台线程运行。
  - worker(handle) 收到一个 JobHandle，可调用 handle.progress(pct, message)
    上报进度、handle.cancelled 检查是否被取消。
  - get(job_id) 返回当前快照（status/progress/message/result/error）。
  - cancel(job_id) 请求取消（协作式：worker 需主动检查 handle.cancelled）。

纯标准库实现，无第三方依赖；任务结果在内存中保留一段时间后自动清理。
"""

import threading
import time
import uuid


class JobCancelled(Exception):
    """worker 检测到取消请求时可抛出，管理器据此把任务标记为 cancelled。"""


class JobHandle:
    """传给 worker 的句柄：上报进度 + 查询取消状态。"""

    def __init__(self, record, cancel_event):
        self._record = record
        self._cancel_event = cancel_event

    @property
    def cancelled(self):
        return self._cancel_event.is_set()

    def raise_if_cancelled(self):
        if self._cancel_event.is_set():
            raise JobCancelled()

    def progress(self, value, message=None):
        with self._record["lock"]:
            if value is not None:
                self._record["progress"] = max(0, min(100, int(value)))
            if message is not None:
                self._record["message"] = str(message)


class JobManager:
    def __init__(self, max_workers=2, retain_seconds=900):
        self._jobs = {}
        self._lock = threading.Lock()
        self._semaphore = threading.Semaphore(max_workers)
        self._retain_seconds = retain_seconds

    def submit(self, kind, worker):
        job_id = uuid.uuid4().hex
        cancel_event = threading.Event()
        record = {
            "id": job_id,
            "kind": kind,
            "status": "queued",        # queued | running | completed | failed | cancelled
            "progress": 0,
            "message": "排队中…",
            "result": None,
            "error": None,
            "created_at": time.time(),
            "updated_at": time.time(),
            "cancel_event": cancel_event,
            "lock": threading.Lock(),
        }
        with self._lock:
            self._cleanup_locked()
            self._jobs[job_id] = record

        def run():
            with self._semaphore:
                if cancel_event.is_set():
                    self._finish(record, "cancelled", message="已取消")
                    return
                with record["lock"]:
                    record["status"] = "running"
                    record["message"] = "处理中…"
                    record["updated_at"] = time.time()
                handle = JobHandle(record, cancel_event)
                try:
                    result = worker(handle)
                    if cancel_event.is_set():
                        self._finish(record, "cancelled", message="已取消")
                    else:
                        self._finish(record, "completed", result=result, progress=100, message="完成")
                except JobCancelled:
                    self._finish(record, "cancelled", message="已取消")
                except Exception as exc:  # noqa: BLE001 - 后台任务需捕获一切并落到任务表
                    self._finish(record, "failed", error=f"{type(exc).__name__}: {exc}")

        thread = threading.Thread(target=run, name=f"job-{kind}-{job_id[:8]}", daemon=True)
        thread.start()
        return job_id

    def _finish(self, record, status, result=None, error=None, progress=None, message=None):
        with record["lock"]:
            record["status"] = status
            if result is not None:
                record["result"] = result
            if error is not None:
                record["error"] = error
            if progress is not None:
                record["progress"] = progress
            if message is not None:
                record["message"] = message
            record["updated_at"] = time.time()

    def get(self, job_id):
        with self._lock:
            record = self._jobs.get(job_id)
        if not record:
            return None
        with record["lock"]:
            return {
                "id": record["id"],
                "kind": record["kind"],
                "status": record["status"],
                "progress": record["progress"],
                "message": record["message"],
                "result": record["result"],
                "error": record["error"],
            }

    def cancel(self, job_id):
        with self._lock:
            record = self._jobs.get(job_id)
        if not record:
            return False
        record["cancel_event"].set()
        with record["lock"]:
            if record["status"] in ("queued", "running"):
                record["message"] = "正在取消…"
                record["updated_at"] = time.time()
        return True

    def _cleanup_locked(self):
        """清理已结束且超过保留期的任务（调用方须持有 self._lock）。"""
        now = time.time()
        stale = [
            job_id for job_id, record in self._jobs.items()
            if record["status"] in ("completed", "failed", "cancelled")
            and now - record["updated_at"] > self._retain_seconds
        ]
        for job_id in stale:
            self._jobs.pop(job_id, None)
