'use strict';

const fs = require('fs');
const fsp = fs.promises;
const p = require('path');
const {sep} = p;
const {execCommandLine} = require('./utilities/exec');
const walk = require('../action-walk');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('chai-as-promised'));

const cp = require('node:child_process');
const os = require('node:os');

const isWindows = os.type() === 'Windows_NT';

// calculate expected results using stat, du, and find.
const testdir = '.';
let testdirStat;

describe('verify that action-walk works as expected', function() {
  let directories;
  let files;
  let links;
  let others;
  let coreInfo;
  let exclusionsInfo;
  let cumulativeDirs = {};

  // using find to collect all the file and directory sizes is a little
  // bit slow, so give it a minute.
  this.timeout() < 60_000 && this.timeout(60_000);

  // tests need to account for du counting the target directory itself
  // while walk treats that as a starting point and only counts the
  // contents of the directory.
  before(async function getTestDirSize() {
    let getCommonFormat = isWindows ? getCommonFormatWin : getCommonFormatUx;
    return fsp.stat(testdir)
      .then(s => {
        testdirStat = s;
      })
      .then(() => getCommonFormat(testdir))
      .then(common => getExpectedValues(testdir, common, {exclusions: ['node_modules']}))
      .then(expected => {
        ({
          directories,
          files,
          links,
          others,
          coreInfo,
          exclusionsInfo,
        } = expected);
      })
      .then(() => {
        for (const item of coreInfo) {
          if (item.type === 'd') {
            cumulativeDirs[item.path] = item.bytes;
          }
        }
      })
      .then(() => {
        expect(others).deep.equal({}, 'there should be only files, directories, and links');
      })
  })

  it('should work with no arguments other than a directory', async function() {
    let dir = isWindows ? '\\log' : '/dev';
    return walk(dir);
  });

  it('should reject if the argument is not a directory', function() {
    return expect(walk('./package.json')).eventually.rejected;
  })

  it('the directory stack should be correct', function() {
    // this test needs to change if files are added to or removed from
    // the test directory.
    const expected = {
      'basics.test.js': ['test'],
      'windows.js': ['test'],
      'fixtures': ['test'],
      [`fixtures${sep}linked-file.js`]: ['test', 'fixtures'],
      'utilities': ['test'],
      [`utilities${sep}exec.js`]: ['test', 'utilities']
    };
    const prefix = `test${sep}`;

    const action = (path, ctx) => {
      const p = path.slice(path.indexOf(prefix) + prefix.length);
      expect(ctx.stack).deep.equal(expected[p]);
    };

    const options = {
      dirAction: action, fileAction: action, linkAction: action,
    }
    return walk(`${testdir}/test`, options);
  });

  it('should work with non-file, non-directory, non-link file types', function() {
    // no device files on windows
    if (isWindows) {
      this.skip();
    }
    const options = {
      otherAction: () => options.own.other += 1,
      own: {other: 0},
    };
    return walk('/dev', options)
      .then(() => {
        expect(options.own.other).not.equal(0);
      });
  });

  it('should count the correct number of directories, files, and links', function() {
    // action-walk doesn't count the target directory itself, so add it.
    let dirCount = 1;
    let fileCount = 0;
    let linkCount = 0;
    let otherCount = 0;
    const options = {
      dirAction: (path, ctx) => dirCount += 1,
      fileAction: (path, ctx) => fileCount += 1,
      linkAction: (path, ctx) => linkCount += 1,
      otherAction: (path, ctx) => otherCount += 1,
    }
    const keyCount = prop => Object.keys(prop).length;
    return walk(testdir, options)
      .then(() => {
        expect(dirCount).equal(keyCount(directories), 'directory counts must match');
        expect(fileCount).equal(keyCount(files), 'file counts must match');
        expect(linkCount).equal(keyCount(links), 'link counts must match');
        expect(otherCount).equal(0, 'there should not be other types of directory entries');
      });
  });

  it('calculated totals should differ by targetsize - linksize using stat', function() {
    let delta = 0;
    const options = {
      dirAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      fileAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      linkAction: async (path, ctx) => {
        // because stat reports on the target of the link, not the
        // link itself, this code will typically calculate too large
        // a total because links are small. so this test accumulates
        // the delta difference between the link size and the target
        // size and corrects the total at the end.
        const {target, linkSize, targetSize} = links[path];
        delta += targetSize - linkSize;

        ctx.own.total += ctx.stat.size;
      },
      otherAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      own: {total: 0},
      stat: true
    };

    return walk(testdir, options)
      .then(() => {
        const awTotal = options.own.total;
        const expected = cumulativeDirs[testdir] + delta - testdirStat.size;
        const msg = 'adjusted total bytes should be the same';
        expect(awTotal).equal(expected, msg);
      });
  });

  // if no linkAction, links are handled by fileAction which sees the size of
  // the link file when stat: lstat.
  it('should match calculated totals without a linkAction', function() {
    const options = {
      dirAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      fileAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      otherAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      own: {total: 0},
      stat: 'lstat',
    };

    return walk(testdir, options)
      .then(() => {
        const awTotal = options.own.total;
        const expected = cumulativeDirs[testdir] - testdirStat.size;
        expect(awTotal).equal(expected, 'action-walk should calculate the same total bytes');
      })
  });

  it('should execute recursively matching calculated totals', function() {
    const own = {total: 0, linkCount: 0, dirTotals: {}, skipDirs: []};
    const options = {
      dirAction: daDirsOnly,
      fileAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      linkAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      own,
      stat: 'lstat',
    };

    return walk(testdir, options)
      .then(() => {
        expect(own.total + testdirStat.size).equal(cumulativeDirs[testdir]);
        for (const dir in own.dirTotals) {
          const walkTotal = own.dirTotals[dir];
          const expected = cumulativeDirs[dir];
          const diff = walkTotal - expected;
          expect(walkTotal).equal(expected, `action-walk and calculated mismatch for ${dir}: ${diff}`);
        }
      });
  });

  describe('handles node_modules exclusion', function() {
    let cumulativeDirs = {};

    before(function() {
      for (const item of exclusionsInfo['node_modules']) {
        if (item.type === 'd') {
          cumulativeDirs[item.path] = item.bytes;
        }
      }
    });

    it('should match calculated', function() {
      const options = {
        dirAction: (path, { dirent, stat, own }) => {
          if (own.skipDirs && own.skipDirs.indexOf(dirent.name) >= 0) {
            return 'skip';
          }
          own.total += stat.size;
        },
        fileAction: (path, ctx) => ctx.own.total += ctx.stat.size,
        linkAction: (path, ctx) => ctx.own.total += ctx.stat.size,
        own: { total: 0, skipDirs: ['node_modules'] },
        stat: 'lstat',
      }

      return walk(testdir, options)
        .then(() => {
          const awTotal = options.own.total;
          // TODO BAM
          // always have to adjust for not counting the target directory.
          // probably should change this.
          const cumulative = cumulativeDirs[testdir] - testdirStat.size;
          const delta = awTotal - cumulative;
          expect(awTotal).equal(cumulative, `action-walk and calculated mismatch ${delta}`);
        })
    });

    it('should match calculated when executing recursively', function() {
      const own = { total: 0, dirTotals: {}, skipDirs: ['node_modules'] };
      const options = {
        dirAction: daDirsOnly,
        fileAction: (path, ctx) => ctx.own.total += ctx.stat.size,
        linkAction: (path, ctx) => ctx.own.total += ctx.stat.size,
        own,
        stat: 'lstat',
      };

      return walk(testdir, options)
        .then(() => {
          expect(own.total + testdirStat.size).equal(cumulativeDirs[testdir]);
          for (const dir in own.dirTotals) {
            const walkTotal = own.dirTotals[dir];
            const expected = cumulativeDirs[dir];
            expect(walkTotal).equal(expected, `action-walk and calculated mismatch for ${dir}`);
          }
        });
    });
  })
});


//
// utilities
//

async function daDirsOnly(path, ctx) {
  const {dirent, stat, own} = ctx;
  if (own.skipDirs && own.skipDirs.indexOf(dirent.name) >= 0) {
    return 'skip';
  }
  own.dirTotals[path] = 0;
  const newown = {total: 0, dirTotals: own.dirTotals};
  const options = {
    dirAction: daDirsOnly,
    fileAction: (path, ctx) => ctx.own.total += ctx.stat.size,
    linkAction: (path, ctx) => ctx.own.total += ctx.stat.size,
    own: newown,
    stat: 'lstat',
  };
  await walk(path, options);
  own.dirTotals[path] = newown.total + stat.size;
  own.total += newown.total + stat.size;

  // skip it because the recursive call counted the subtree.
  return 'skip';
}

const BYTES = Symbol('bytes');
const TYPE = Symbol('type');

function getCommonFormatWin(rootdir) {
  const rootDirResolved = p.resolve(rootdir);

  // regex to match what the powershell script outputs.
  const re = new RegExp('^(\\d+) ' + rootDirResolved.replace(/\\/g, '\\\\') + '(.+) (d|f|l)$');
  // the script outputs lines like: "4096 C:\Users\joe\test\testdir d", where the last
  // character is 'd' for directory, 'f' for file, and 'l' for link.
  let results = cp.spawnSync('.\\scripts\\file-sizes.ps1', [rootdir], { shell: 'powershell.exe' });

  if (results.stderr.length > 0) {
    throw new Error('error fetching file sizes:' + results.stderr.toString());
  }
  // normalize to windows path
  if (rootdir.startsWith('./')) {
    rootdir = '.\\' + rootdir.slice(2);
  }

  // windows doesn't report the rootdir item itself, so add it here.
  const items = [{ name: rootdir, type: 'd', bytes: 0 }];

  const lines = results.stdout.toString().split('\n');
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      let name = p.join(rootdir, m[2]);
      if (rootdir === '.' || rootdir.startsWith('.\\')) {
        name = '.\\' + name;
      }
      const type = m[3];
      // windows reports 0 for the size of links
      let bytes = +m[1];
      if (type === 'l') {
        bytes = fs.lstatSync(name).size;
      }
      items.push({ name, type, bytes });
    }
  }

  return items;
}

function getCommonFormatUx(rootdir) {
  const rootDirResolved = p.resolve(rootdir);

  // regex to match the output of the following find command. It needs to be
  // rearranged to match the common format.
  const re = new RegExp('^(\\d+) (.).{9} ' + '(.+)$');

  // `find node_modules/.bin -exec stat --printf "%s %A" {} ';' -exec echo " "{} ';'`
  // 4096 drwxr-xr-x test
  // 6644 -rw-r--r-- test/index.test.js
  // and we convert to "4096 test d" and "6644 test/index.test.js f" so common processing
  // with results of the file-sizes.ps1 script.
  const r = cp.execSync(`find ${rootdir} -exec stat --format "%s %A %n" {} ';'`);
  const lines = r.toString().split('\n');
  const items = [];
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      const bytes = +m[1];
      const type = m[2] === '-' ? 'f' : m[2];
      const name = m[3];
      items.push({ name, type, bytes });
    }
  }
  return items;
}

async function getExpectedValues(rootdir, common, options = {}) {
  const directories = {};
  const files = {};
  const links = {};
  const others = {};

  const {exclusions = []} = options;

  // the default exclusion group is "nothing is excluded". others can be
  // added. this works because a path element must have a non-zero length.
  exclusions.unshift('');
  const exclusionTrees = new Map();
  for (const exclusion of exclusions) {
    exclusionTrees.set(exclusion, { dirtreeRoot: { [BYTES]: 0, [TYPE]: 'd' } });
  }

  // simulate approximately what 'du -ab' does.
  for (const item of common) {
    const {name: relativePath, type, bytes} = item;

    if (type === 'd') {
      directories[relativePath] = bytes;
    } else if (type === 'f') {
      files[relativePath] = bytes;
    } else if (type === 'l') {
      // here we are adjusting for a significant windows vs. linux difference.
      // - windows reports a size of 0 for links, neither the size of the link
      // file nor the size of the target file.
      // - linux ls reports the size of the link file for links, ls -l reports
      // the size of the target file.
      // - node lstat reports the size of the link file, stat reports the size
      // of the target file.
      //
      // so we store both the link size and the target size for links. should
      // we also adjust the raw data being returned by the getCommonFormat
      // functions?
      let linkSize = (await fsp.lstat(relativePath)).size;

      // the link is relative to the linked file, not the CWD.
      const target = await fsp.readlink(relativePath);
      const targetPath = p.resolve(p.dirname(relativePath), target);
      const targetSize = (await fsp.stat(targetPath)).size;

      links[relativePath] = {target, linkSize, targetSize};
    } else {
      // this is an error, but let's record it so we know.
      others[relativePath] = {type, bytes};
    }

    const fullpath = p.resolve(relativePath);

    // the path elements as an array, e.g., ['node_modules', '@contrast', ...]
    const relativePathElements = relativePath.split(p.sep);

    // start at the root each iteration of the loop
    for (const exclusion of exclusions) {
      const {dirtreeRoot} = exclusionTrees.get(exclusion);
      // if this is the first time we've seen nextElement, add it to
      // the previous element. otherwise just add to the byte count.
      let treeStack = [dirtreeRoot];

      // don't add excluded elements. NOTE: the default exclusion, '', can't
      // match any path element.
      if (relativePathElements.includes(exclusion)) {
        continue;
      }
      // aggregate counts for each item in the tree. each tree entry is
      // an object containing all leaf items and sub-trees. it also keeps
      // the byte count for all leaf and sub-tree items.
      //
      // add each element's size to the predecessor byte counts because all
      // items in the path contain the element.
      for (let i = 0; i < relativePathElements.length; i++) {
        const nextElement = relativePathElements[i];

        // if this is the first time we've seen nextElement, add it to
        // the previous element. otherwise just add to the byte count.
        if (!(nextElement in treeStack[treeStack.length - 1])) {
          const newItem = { [BYTES]: bytes, [TYPE]: type };
          treeStack[treeStack.length - 1][nextElement] = newItem;
          treeStack.push(newItem);
        } else {
          treeStack[treeStack.length - 1][nextElement][BYTES] += bytes;
          treeStack.push(treeStack[treeStack.length - 1][nextElement]);
        }
      }
    }
  }

  const { dirtreeRoot } = exclusionTrees.get('');
  const coreInfo = walktree(dirtreeRoot);

  const exclusionsInfo = {};
  for (const [key, {dirtreeRoot}] of exclusionTrees.entries()) {
    if (key === '') {
      continue;
    }
    exclusionsInfo[key] = walktree(dirtreeRoot);
  }

  return {
    directories,
    files,
    links,
    others,
    coreInfo,
    exclusionsInfo,
  };
}

function walktree(tree) {
  const branch = [];
  const results = [];

  function _walktree(tree) {
    for (const key of Object.keys(tree)) {
      branch.push(key);
      _walktree(tree[key], branch);
      results.push({ path: branch.join(p.sep), bytes: tree[key][BYTES], type: tree[key][TYPE] });
      //console.log(branch.join(p.sep), tree[key][BYTES])
      branch.pop();
    }
  }
  _walktree(tree);

  return results;
}
