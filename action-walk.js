const fsp = require('fs').promises;
const path = require('path');

async function walk (dir, options = {}) {
  const noop = async () => undefined;
  let fileAction;
  let dirAction = noop;
  let linkAction;
  let otherAction;
  let stat;
  if (options.stat === 'stat' || options.stat === 'lstat') {
    stat = options.stat;
  } else if (options.stat) {
    stat = 'stat';
  }

  if (options.fileAction) {
    fileAction = async (filepath, ctx) => options.fileAction(filepath, ctx);
  }
  if (options.dirAction) {
    dirAction = async (filepath, ctx) => options.dirAction(filepath, ctx);
  }
  if (options.linkAction) {
    linkAction = async (filepath, ctx) => options.linkAction(filepath, ctx);
  }
  if (options.otherAction) {
    otherAction = async (filepath, ctx) => options.otherAction(filepath, ctx);
  }

  //
  // walk through a directory tree calling user functions for each entry.
  //
  async function walker (dir) {
    for await (const dirent of await fsp.opendir(dir)) {
      const entry = path.join(dir, dirent.name);
      const ctx = {dirent};
      if (options.own) {
        ctx.own = options.own;
      }
      if (stat) {
        ctx.stat = await fsp[stat](entry);
      }
      if (dirent.isDirectory() && await dirAction(entry, ctx) !== 'skip') {
        await walker(entry);
      } else if (dirent.isFile()) {
        fileAction && await fileAction(entry, ctx);
      } else if (dirent.isSymbolicLink()) {
        if (!linkAction) {
          fileAction && await fileAction(entry, ctx);
        } else {
          linkAction && await linkAction(entry, ctx);
        }
      } else {
        otherAction && await otherAction(entry, ctx);
      }
    }
    return undefined;
  }

  return walker(dir);
}

module.exports = walk;
