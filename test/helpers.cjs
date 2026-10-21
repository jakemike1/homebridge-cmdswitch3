const { failure } = require("../command-runner");
class FakeRunner {
  constructor() {
    this.jobs = [];
  }
  run(command, timeout, key, options) {
    let resolve, reject;
    const job = {
      command,
      timeout,
      key,
      options,
      settled: false,
      promise: new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
      done(code = 0, stdout = "") {
        if (!this.settled) {
          this.settled = true;
          resolve({ code, stdout });
        }
      },
      fail(error) {
        if (!this.settled) {
          this.settled = true;
          reject(error);
        }
      },
      cancel(error = failure("CANCELLED", "cancelled")) {
        this.fail(error);
      },
    };
    this.jobs.push(job);
    return job;
  }
  dispose() {
    this.jobs.forEach((job) => job.cancel());
  }
}

module.exports = {
  FakeRunner,
  turn: () => new Promise((resolve) => setImmediate(resolve)),
};
