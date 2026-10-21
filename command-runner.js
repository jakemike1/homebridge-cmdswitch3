"use strict";
const { spawn } = require("node:child_process");

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

// Shell syntax is intentionally retained for legacy configuration compatibility.
// Only dimmer state reads capture bounded stdout. No command or output is logged.
// Commands are never retried.
class CommandRunner {
  constructor({
    concurrency = 4,
    pendingLimit = 128,
    maxOutputBytes = 1024 * 1024,
  } = {}) {
    this.concurrency = concurrency;
    this.pendingLimit = pendingLimit;
    this.maxOutputBytes = maxOutputBytes;
    this.pending = [];
    this.active = new Set();
    this.reservations = new Set();
    this.sequence = 0;
    this.closed = false;
  }

  run(command, timeoutMs, key, options = {}) {
    let resolve, reject;
    const job = {
      command,
      key,
      options,
      order: options.reservation?.order ?? this.sequence++,
      stdout: [],
      settled: false,
      stopping: false,
      child: null,
      promise: new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
      resolve,
      reject,
    };
    job.cancel = (error = failure("CANCELLED", "Command cancelled")) =>
      this.stop(job, error);
    this.reservations.delete(options.reservation);
    if (
      typeof command !== "string" ||
      !command.trim() ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      this.finish(
        job,
        failure("INVALID_COMMAND", "Invalid command or execution deadline"),
      );
    } else if (this.closed) {
      this.finish(job, failure("CANCELLED", "Command runner is closed"));
    } else if (
      this.pending.length + this.reservations.size >=
      this.pendingLimit
    ) {
      this.finish(job, failure("QUEUE_FULL", "Command queue is full"));
    } else {
      job.deadline = setTimeout(
        () =>
          this.stop(
            job,
            failure("TIMEOUT", "Command execution deadline exceeded"),
          ),
        timeoutMs,
      );
      this.pending.push(job);
      this.drain();
    }
    return job;
  }

  // Reserve acceptance order while an accessory waits for its preceding write.
  // This keeps synchronous mode FIFO across accessories as well as within one.
  reserve() {
    if (this.concurrency !== 1) return undefined;
    if (this.closed) throw failure("CANCELLED", "Command runner is closed");
    if (this.pending.length + this.reservations.size >= this.pendingLimit)
      throw failure("QUEUE_FULL", "Command queue is full");
    const token = { order: this.sequence++ };
    this.reservations.add(token);
    return token;
  }

  release(token) {
    this.reservations.delete(token);
    this.drain();
  }

  drain() {
    while (
      !this.closed &&
      this.active.size < this.concurrency &&
      this.pending.length
    ) {
      this.pending.sort((a, b) => a.order - b.order);
      const index = this.pending.findIndex(
        (job) =>
          job.key === undefined ||
          ![...this.active].some((active) => active.key === job.key),
      );
      if (index === -1) return;
      if (
        this.concurrency === 1 &&
        [...this.reservations].some(
          (token) => token.order < this.pending[index].order,
        )
      )
        return;
      const [job] = this.pending.splice(index, 1);
      if (!job.settled) this.start(job);
    }
  }

  start(job) {
    this.active.add(job);
    try {
      job.child = spawn(job.command, {
        shell: true,
        env: optionsEnvironment(job.options),
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Do not retain an additional command copy in the scheduler after spawn.
      delete job.command;
      const captureStdout = job.options.captureStdout === true;
      delete job.options;
      for (const stream of [job.child.stdout, job.child.stderr]) {
        let bytes = 0;
        stream.on("data", (chunk) => {
          bytes += chunk.length;
          if (
            bytes <= this.maxOutputBytes &&
            captureStdout &&
            stream === job.child.stdout &&
            !job.stopping &&
            !job.settled
          )
            job.stdout.push(chunk);
          if (bytes > this.maxOutputBytes)
            this.stop(
              job,
              failure("OUTPUT_LIMIT", "Command output limit exceeded"),
            );
        });
      }
      job.child.once("error", () => {
        if (!job.stopping)
          this.stop(job, failure("SPAWN_FAILED", "Unable to start command"));
      });
      job.child.once("close", (code, signal) => {
        if (job.stopping) {
          // Descendants may outlive the shell. Keep escalation until the group is gone.
          if (!this.groupExists(job)) this.finish(job, job.stopError);
        } else if (signal !== null || !Number.isInteger(code)) {
          this.finish(
            job,
            failure("TERMINATED", "Command terminated without an exit status"),
          );
        } else {
          this.finish(
            job,
            null,
            captureStdout
              ? { code, stdout: Buffer.concat(job.stdout).toString("utf8") }
              : { code },
          );
        }
      });
    } catch {
      this.stop(job, failure("SPAWN_FAILED", "Unable to start command"));
    }
  }

  groupExists(job) {
    if (!job.child?.pid) return false;
    if (process.platform === "win32")
      return job.child.exitCode === null && job.child.signalCode === null;
    try {
      process.kill(-job.child.pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  }

  signal(job, signal) {
    if (!job.child?.pid) return;
    try {
      if (process.platform === "win32") job.child.kill(signal);
      else process.kill(-job.child.pid, signal);
    } catch {
      /* Already exited, or the OS refuses the signal. Deadline still settles. */
    }
  }

  stop(job, error) {
    if (job.settled || job.stopping) return;
    job.stopping = true;
    job.stopError = error;
    clearTimeout(job.deadline);
    if (!job.child?.pid) {
      this.finish(job, error);
      return;
    }
    this.signal(job, "SIGTERM");
    job.escalation = setTimeout(() => {
      this.signal(job, "SIGKILL");
      job.child.stdout?.destroy();
      job.child.stderr?.destroy();
      job.child.unref();
      this.finish(job, error);
    }, 250);
  }

  finish(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.deadline);
    clearTimeout(job.escalation);
    delete job.command;
    delete job.options;
    job.stdout = [];
    const index = this.pending.indexOf(job);
    if (index !== -1) this.pending.splice(index, 1);
    this.active.delete(job);
    if (error) job.reject(error);
    else job.resolve(result);
    this.drain();
  }

  dispose() {
    this.closed = true;
    this.reservations.clear();
    for (const job of [...this.pending, ...this.active]) job.cancel();
  }
}

function optionsEnvironment(options) {
  return options.env ? { ...process.env, ...options.env } : process.env;
}

module.exports = { CommandRunner, failure };
