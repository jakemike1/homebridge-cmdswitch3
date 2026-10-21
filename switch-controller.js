"use strict";
const { failure } = require("./command-runner");

class SwitchController {
  constructor(
    config,
    context,
    runner,
    publish,
    diagnostic,
    activity = () => {},
  ) {
    this.config = config;
    this.context = context;
    this.runner = runner;
    this.publish = publish;
    this.diagnostic = diagnostic;
    this.activity = activity;
    this.dimmer = Boolean(config.dim_cmd);
    this.closed = false;
    this.generation = 0;
    this.queue = [];
    this.read = null;
    this.active = null;
    this.lastError = null;
    if (typeof context.state !== "boolean")
      context.state = !this.dimmer && Boolean(config.off_cmd && !config.on_cmd);
    if (this.dimmer) {
      if (
        !Number.isInteger(context.brightness) ||
        context.brightness < 0 ||
        context.brightness > 100
      )
        context.brightness = config.brightness;
      if (
        !Number.isInteger(context.lastBrightness) ||
        context.lastBrightness < 1 ||
        context.lastBrightness > 100
      )
        context.lastBrightness = context.brightness || config.brightness || 100;
    }
  }

  start() {
    if (this.config.state_cmd) this.refresh().catch(() => {});
  }

  schedule(delay) {
    clearTimeout(this.pollTimer);
    if (this.closed || !this.config.state_cmd) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.refresh().catch(() => {});
    }, delay);
  }

  report(error) {
    if (this.closed) return;
    if (this.lastError?.code !== error.code) this.diagnostic(error.code);
    this.lastError = error;
    this.publish(error);
  }

  get() {
    if (this.closed)
      return Promise.reject(failure("CANCELLED", "Switch is unavailable"));
    if (
      !this.config.polling &&
      this.config.state_cmd &&
      !this.active &&
      !this.queue.length
    )
      return this.refresh();
    if (this.lastError) return Promise.reject(this.lastError);
    return Promise.resolve(this.context.state);
  }

  async getBrightness() {
    await this.get();
    return this.context.brightness;
  }

  publishState() {
    this.publish(
      this.context.state,
      this.dimmer ? this.context.brightness : undefined,
    );
  }

  refresh() {
    if (this.closed)
      return Promise.reject(failure("CANCELLED", "Switch is unavailable"));
    if (!this.config.state_cmd || this.active || this.queue.length)
      return Promise.resolve(this.context.state);
    if (this.read) return this.read.promise;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const generation = this.generation;
    const read = {
      job: this.runner.run(
        this.config.state_cmd,
        this.config.stateTimeout * 1000,
        this.config.name,
        { captureStdout: this.dimmer },
      ),
    };
    this.read = read;
    read.promise = read.job.promise
      .then(({ code, stdout }) => {
        if (this.closed) throw failure("CANCELLED", "Switch is unavailable");
        if (generation !== this.generation) return this.context.state;
        if (this.config.strictState && code !== 0 && code !== 1)
          throw failure("STATE_FAILED", "State command failed");
        const previous = [this.context.state, this.context.brightness];
        if (this.dimmer) {
          let brightness = 0;
          if (code === 0) {
            const output = typeof stdout === "string" ? stdout.trim() : "";
            if (!/^\d{1,3}$/.test(output) || Number(output) > 100)
              throw failure(
                "INVALID_STATE",
                "Dimmer state must be an integer from 0 to 100",
              );
            brightness = Number(output);
          }
          this.context.brightness = brightness;
          if (brightness > 0) this.context.lastBrightness = brightness;
          this.context.state = brightness > 0;
        } else this.context.state = code === 0;
        this.lastError = null;
        this.publishState();
        if (
          previous[0] !== this.context.state ||
          previous[1] !== this.context.brightness
        )
          this.activity("State updated");
        return this.context.state;
      })
      .catch((error) => {
        if (this.closed) throw failure("CANCELLED", "Switch is unavailable");
        if (generation !== this.generation) return this.context.state;
        this.report(error);
        throw error;
      })
      .finally(() => {
        if (this.read === read) this.read = null;
        if (
          !this.closed &&
          !this.active &&
          !this.queue.length &&
          this.config.polling
        )
          this.schedule(this.config.interval * 1000);
      });
    return read.promise;
  }

  set(value) {
    return this.enqueue(value, false);
  }

  setBrightness(value) {
    if (!this.dimmer || !Number.isInteger(value) || value < 0 || value > 100)
      return Promise.reject(
        failure("INVALID_VALUE", "Brightness must be an integer from 0 to 100"),
      );
    return this.enqueue(value, true);
  }

  enqueue(value, brightness) {
    if (this.closed)
      return Promise.reject(failure("CANCELLED", "Switch is unavailable"));
    if (!brightness && typeof value !== "boolean")
      return Promise.reject(
        failure("INVALID_VALUE", "Switch value must be boolean"),
      );
    if (this.queue.length + (this.active ? 1 : 0) >= this.config.queueLimit) {
      return Promise.reject(
        failure("QUEUE_FULL", "Switch command queue is full"),
      );
    }
    const command = this.dimmer
      ? !brightness && !value && this.config.off_cmd
        ? this.config.off_cmd
        : this.config.dim_cmd
      : value
        ? this.config.on_cmd
        : this.config.off_cmd;
    const opposite = value ? this.config.off_cmd : this.config.on_cmd;
    // Missing direction of an explicitly one-command momentary switch is a passive reset.
    if (!command && (this.config.state_cmd || !opposite)) {
      return Promise.reject(
        failure(
          "MISSING_COMMAND",
          "No command is configured for this direction",
        ),
      );
    }
    let reservation;
    try {
      reservation = this.runner.reserve?.();
    } catch (error) {
      return Promise.reject(error);
    }
    this.generation++;
    clearTimeout(this.pollTimer);
    clearTimeout(this.resetTimer);
    this.read?.job.cancel();
    let resolve, reject;
    const task = {
      value,
      brightness,
      reservation,
      command,
      acceptedAt: Date.now(),
      promise: new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
      resolve,
      reject,
    };
    task.timer = setTimeout(() => {
      if (this.active === task)
        task.job?.cancel(
          failure("TIMEOUT", "Command execution deadline exceeded"),
        );
      else if (this.queue.includes(task)) {
        this.queue.splice(this.queue.indexOf(task), 1);
        this.runner.release?.(task.reservation);
        const error = failure(
          "TIMEOUT",
          "Queued command execution deadline exceeded",
        );
        this.report(error);
        task.reject(error);
      }
    }, this.config.commandTimeout * 1000);
    this.queue.push(task);
    this.drain();
    return task.promise;
  }

  drain() {
    if (this.closed || this.active || !this.queue.length) return;
    const task = this.queue.shift();
    this.active = task;
    // Cancelled reads must finish process cleanup before a write starts.
    const read = this.read?.promise;
    Promise.resolve(read)
      .catch(() => {})
      .then(async () => {
        if (this.closed || this.active !== task)
          throw failure("CANCELLED", "Switch is unavailable");
        const remaining =
          this.config.commandTimeout * 1000 - (Date.now() - task.acceptedAt);
        if (remaining <= 0)
          throw failure(
            "TIMEOUT",
            "Queued command execution deadline exceeded",
          );
        // Resolve ON when execution starts, after preceding successful writes.
        const level = this.dimmer
          ? task.brightness
            ? task.value
            : task.value
              ? this.context.lastBrightness
              : 0
          : undefined;
        if (task.command) {
          task.job = this.runner.run(
            task.command,
            Math.min(remaining, this.config.commandTimeout * 1000),
            this.config.name,
            {
              reservation: task.reservation,
              ...(this.dimmer ? { env: { HB_BRIGHTNESS: String(level) } } : {}),
            },
          );
          const { code } = await task.job.promise;
          if (code !== 0)
            throw failure("ACTION_FAILED", "Switch command failed");
        }
        if (this.closed || this.active !== task)
          throw failure("CANCELLED", "Switch is unavailable");
        if (this.dimmer) {
          this.context.brightness = level;
          if (level > 0) this.context.lastBrightness = level;
          this.context.state = level > 0;
        } else this.context.state = task.value;
        this.lastError = null;
        this.publishState();
        this.activity(
          task.brightness
            ? `Brightness set to ${level}%`
            : `Turned ${task.value ? "on" : "off"}`,
        );
        task.succeeded = true;
        task.executed = Boolean(task.command);
        task.resolve();
      })
      .catch((error) => {
        if (!this.closed) this.report(error);
        task.reject(error);
        // Once an action fails, later queued intent must not execute unexpectedly.
        for (const queued of this.queue.splice(0)) {
          clearTimeout(queued.timer);
          this.runner.release?.(queued.reservation);
          queued.reject(
            failure(
              "CANCELLED",
              "Queued action cancelled after an earlier failure",
            ),
          );
        }
      })
      .finally(() => {
        clearTimeout(task.timer);
        this.runner.release?.(task.reservation);
        delete task.command;
        if (this.active === task) this.active = null;
        if (this.closed) return;
        if (this.queue.length) {
          this.drain();
          return;
        }
        if (this.config.state_cmd) this.schedule(this.config.timeout * 1000);
        else if (
          task.succeeded &&
          task.executed &&
          !this.dimmer &&
          Boolean(this.config.on_cmd) !== Boolean(this.config.off_cmd)
        ) {
          // updateValue in publish never invokes a SET handler.
          this.resetTimer = setTimeout(() => {
            if (this.closed) return;
            this.context.state = Boolean(this.config.off_cmd);
            this.publish(this.context.state);
          }, 1000);
        }
      });
  }

  dispose() {
    this.closed = true;
    this.generation++;
    clearTimeout(this.pollTimer);
    clearTimeout(this.resetTimer);
    this.read?.job.cancel();
    if (this.active) {
      clearTimeout(this.active.timer);
      this.runner.release?.(this.active.reservation);
      this.active.job?.cancel();
      this.active.reject(failure("CANCELLED", "Switch is unavailable"));
    }
    for (const task of this.queue.splice(0)) {
      clearTimeout(task.timer);
      this.runner.release?.(task.reservation);
      task.reject(failure("CANCELLED", "Switch is unavailable"));
    }
  }
}

module.exports = { SwitchController };
