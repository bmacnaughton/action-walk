const exec = require('child_process').exec;

async function execCommandLine (cmdline, options = {}) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line no-unused-vars
    const cp = exec(cmdline, options, function (error, stdout, stderr) {
      if (error) {
        reject({error, stdout, stderr});
      } else {
        resolve({stdout, stderr});
      }
    });
  });
}

module.exports = {
  execCommandLine,
}
