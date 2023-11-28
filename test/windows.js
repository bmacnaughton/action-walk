'use strict';

const fsp = require('fs').promises;
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
const duOutput = {
  w_node: {},
  wo_node: {},
  w_nodePaths: [],
  wo_nodePaths: [],
}
const findOutput = {
  files: {},
  directories: {},
  links: new Map(),
}

describe('verify that action-walk works as expected', function() {
  let allPaths;
  let allTotalBytes;
  let directories;
  let files;
  let links;
  let others;
  let coreInfo;
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
      .then(common => getExpectedValues(testdir, common))
      .then(expected => {
        ({
          allPaths,
          allTotalBytes,
          directories,
          files,
          links,
          others,
          coreInfo,
        } = expected);
      })
      .then(() => {
        for (const item of coreInfo) {
          if (item.type === 'd') {
            cumulativeDirs[item.path] = item.bytes;
          }
        }
      })
  })

  it('should work with no arguments other than a directory', async function() {
    let dir = isWindows ? '\\program files (x86)\\WindowsPowerShell' : '/dev';
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
    // unix "find" includes the argument directory; get-childitem does not. action-walk
    // does not include the argument directory either.
    let dirCount = isWindows ? 0 : 1; // the starting directory
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

  it('du -ab totals should differ by targetsize - linksize using stat', function() {
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
      for (const item of coreInfo) {
        const {path, bytes, type} = item;
        const pathElements = path.split(p.sep);
        if (pathElements.includes('node_modules')) {
          continue;
        }
        cumulativeDirs[path] = bytes;
      }
    });

    it('should match du -ab --exclude=node_modules', function() {
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
          const cumulative = cumulativeDirs[testdir];
          console.log('awTotal', awTotal, cumulative);
        })
    });

    it.skip('should execute recursively matching du -b --exclude=node_modules', function() {
      const own = { total: 0, linkCount: 0, dirTotals: {}, skipDirs: ['node_modules'] };
      const options = {
        dirAction: daDirsOnly,
        fileAction: (path, ctx) => ctx.own.total += ctx.stat.size,
        linkAction: (path, ctx) => ctx.own.total += ctx.stat.size,
        own,
        stat: 'lstat',
      };

      return walk(testdir, options)
        .then(() => {
          expect(own.total + testdirStat.size).equal(duOutput.wo_node[testdir]);
          for (const dir in own.dirTotals) {
            const walkTotal = own.dirTotals[dir];
            const duTotal = duOutput.wo_node[dir];
            expect(walkTotal).equal(duTotal, `action-walk and du mismatch for ${dir}`);
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

function parseSizeSpacePath(text) {
  const o = {};
  const re = /(?<size>\d+)\s+(?<path>.+)/g;
  let m;
  while ((m = re.exec(text))) {
    o[m.groups.path] = +m.groups.size;
  }

  return o;
}

function parseLinkArrowTarget(text) {
  const r = [];
  const re = /(?<target>.+)\s+->\s+(?<link>.+)/g;
  let m;
  while (m = re.exec(text)) {
    r.push({link: m.groups.link, target: m.groups.target})
  }

  return r;
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

  // windows doesn't report the rootdir item itself, so add it here.
  const items = [{ name: rootdir, type: 'd', size: 0 }];

  const lines = results.stdout.toString().split('\n');
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      const bytes = +m[1];
      const name = p.join(rootdir, m[2]);
      const type = m[3];
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
  const dirtreeRoot = {[BYTES]: 0, [TYPE]: 'd'};

  let allPaths = [];
  let allTotalBytes = 0;

  // duOutput has totals for each directory
  // findOutput is just a list of files/directories and their size

  const {exclusions = []} = options;
  // the default exclusion group is "nothing is excluded". others can be
  // added.
  exclusions.unshift('');
  const groups = new Map();
  for (const exclusion of exclusions) {
    groups.set(exclusion, []);
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

    // i don't think we need allPaths; it's the same data as common but just
    // an array.
    allPaths.push(relativePath);
    allTotalBytes += bytes;

    const fullpath = p.resolve(relativePath);

    // the path elements as an array, e.g., ['node_modules', '@contrast', ...]
    const relativePathElements = relativePath.split(p.sep);

    // start at the root each iteration of the loop
    let treeStack = [dirtreeRoot];

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
      if (!(nextElement in treeStack.at(-1))) {
        const newItem = { [BYTES]: bytes, [TYPE]: type };
        treeStack.at(-1)[nextElement] = newItem;
        treeStack.push(newItem);
      } else {
        treeStack.at(-1)[nextElement][BYTES] += bytes;
        treeStack.push(treeStack.at(-1)[nextElement]);
      }
    }
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

  const coreInfo = walktree(dirtreeRoot);

  return {
    allPaths,
    allTotalBytes,
    directories,
    files,
    links,
    others,
    coreInfo,
  };
}


async function getExpectedValuesWinX(rootdir, duOutput, findOutput, dirtreeRoot = {}) {
  const rootDirResolved = p.resolve(rootdir);

  // the script outputs lines like: "4096 C:\Users\joe\test\testdir d", where the last
  // character is 'd' for directory, 'f' for file, and 'l' for link.
  let results = cp.spawnSync('.\\scripts\\file-sizes.ps1', [rootdir], {shell: 'powershell.exe'});

  let lines1 = results.stdout.toString();
  let lines2 = lines1.split('\n');

  const re = new RegExp('^(\\d+) ' + rootDirResolved.replace(/\\/g, '\\\\') + '(.+) (d|f|l)$');

  const {w_nodePaths, wo_nodePaths} = duOutput;
  const {directories, files} = findOutput;
  dirtreeRoot[rootdir] = {[BYTES]: 0, [TYPE]: 'd'};

  let wo_total = 0;
  let w_total = 0;


  // simulate approximately what 'du -ab' does.
  for (const line of lines2) {
    const m = line.match(re);
    if (m) {
      const bytes = +m[1];

      const fullpath = line.slice(m[1].length + 1, -(m[3].length + 1));
      // make the start of our paths the rootdir.
      const relativePath = fullpath.replace(rootDirResolved, rootdir);

      // the path elements as an array, e.g., ['node_modules', '@contrast', ...]
      const relativePathElements = relativePath.split(p.sep);

      // start at the root each time
      let treeStack = [dirtreeRoot];

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
        if (!(nextElement in treeStack.at(-1))) {
          const newItem = {[BYTES]: bytes, [TYPE]: m[3]};
          treeStack.at(-1)[nextElement] = newItem;
          treeStack.push(newItem);
        } else {
          treeStack.at(-1)[nextElement][BYTES] += bytes;
          treeStack.push(treeStack.at(-1)[nextElement]);
        }
      }

      w_nodePaths.push(relativePath);
      w_total += bytes;

      // needs a little work, but we're only skipping subdirectories and
      // they start in the second element. ideally skips should be an
      // array of array of strings.
      if (!['node_modules'].includes(relativePathElements[1])) {
        wo_nodePaths.push(relativePath);
        wo_total += bytes;
      }

      if (m[3] === 'd') {
        directories[relativePath] = bytes;
      } else if (m[3] === 'f') {
        files[relativePath] = bytes;
      } else if (m[3] === 'l') {
        // windows gci info reports 0 length for links; node lstat.size
        // reports 17.
        let link = 0;
        if (!isWindows) {
          link = await (await fsp.lstat(relativePath)).size;
        }
        const targetFile = await fsp.readlink(relativePath);
        // this is windows specific; linux find returns relative to the CWD
        // while windows returns relative to the link.
        const targetPath = p.resolve(p.dirname(relativePath), targetFile);

        const target = await (await fsp.stat(targetPath)).size;
        findOutput.links.set(`${fullpath} => ${targetPath}`, { link, target });
      } else {
        console.log('unexpected item type', m[3]);
      }
    } else {
      // don't know how to suppress ps noise. have changed login script and it
      // is still running old one it seems.
      //console.log('unexpected line', line);
    }
  }

  function walktree(tree) {
    const branch = [];
    const results = [];

    function _walktree(tree) {
      for (const key of Object.keys(tree)) {
        branch.push(key);
        _walktree(tree[key], branch);
        results.push({path: branch.join(p.sep), bytes: tree[key][BYTES], type: tree[key][TYPE]});
        //console.log(branch.join(p.sep), tree[key][BYTES])
        branch.pop();
      }
    }
    _walktree(tree);

    return results;
  }

  const coreInfo = walktree(dirtreeRoot);

  // now insert rootdir totals; the powershell command doesn't report on
  // the rootdir itself.
  duOutput.w_node[rootdir] = w_total;
  duOutput.wo_node[rootdir] = wo_total;

  // w_node gets all the values, wo_node only those that are in
  // wo_nodesPath.
  coreInfo.forEach(info => {
    duOutput.w_node[info.path] = info.bytes;
    if (wo_nodePaths.includes(info.path)) {
      duOutput.wo_node[info.path] = info.bytes;
    }
  });

  return dirtreeRoot;
}

async function getExpectedValuesWin(rootdir, duOutput, findOutput) {
  let results = cp.spawnSync('.\\scripts\\file-sizes.ps1', [rootdir], {shell: 'powershell.exe'});

  let lines1 = results.stdout.toString();
  let lines2 = lines1.split('\n');

  const re = new RegExp('^(\\d+) ' + process.cwd().replace(/\\/g, '\\\\') + '(.+) (d|f)$');
  let count = 0;

  const wo_node = {};
  const w_node = {};
  const directories = {};
  const files = {};

  let wo_total = 0;
  let w_total = 0;

  // this doesn't really do what "du -ab" does, but the test only requires
  // the right information for testdir.
  for (const line of lines2) {
    const m = line.match(re);
    if (m) {
      const bytes = m[1];
      const path = m[2];
      const isDir = m[3] === 'd';
      const fullpath = line.slice(m[1].length, -m[3].length);

      w_node[fullpath] = +m[1];
      w_total += w_node[fullpath];
      //w_node.push({size: +m[1], name: m[2], directory: m[3] === 'd'});

      if (!m[2].startsWith('\\node_modules')) {
        wo_node[fullpath] = +m[1];
        wo_total += wo_node[fullpath];
        //wo_node.push({size: +m[1], name: m[2], directory: m[3] === 'd'});
      }


      if (m[3] === 'd') {
        directories[fullpath] = +m[1];
      } else if (m[3] === 'l') {
        links[fullpath] = +m[1];
      } else {
        files[fullpath] = +m[1];
      }
    } else {
      // don't know how to suppress ps noise. have changed login script and it
      // is still running old one it seems.
      //console.log('unexpected line', line);
    }
  }
  // now fake testdir
  wo_node[testdir] = wo_total;
  w_node[testdir] = w_total;

  duOutput.wo_node = wo_node;
  duOutput.w_node = w_node;
  findOutput.directories = directories;
  findOutput.files = files;
}

async function getExpectedValuesUxX(rootdir, duOutput, findOutput, dirtreeRoot = {}) {
  const re = new RegExp('^(\\d+) (.).{9} ' + '(.+)$');

  // `find node_modules/.bin -exec stat --printf "%s %A" {} ';' -exec echo " "{} ';'`
  // 4096 drwxr-xr-x test
  // 6644 -rw-r--r-- test/index.test.js
  // and we convert to "4096 test d" and "6644 test/index.test.js f" so common processing
  // with results of the file-sizes.ps1 script.
  return execCommandLine(`find ${rootdir} -exec stat --printf "%s %A" {} ';' -exec echo " "{} ';'`)
    .then(r => {
      expect(r).property('stderr', '');
      const text = r.stdout.toString().split('\n');
      const commonFormat = text.map(line => {
        const m = line.match(re);
        if (m) {
          return `${m[1]} ${m[3]} ${m[2] === '-' ? 'f' : m[2]}`;
        } else {
          return line;
        }
      });
      return commonFormat;
    })
}


async function getExpectedValuesUx(rootdir, duOutput, findOutput) {

  return execCommandLine(`du -ab --exclude=node_modules ${rootdir}`)
    .then(r => {
      expect(r).property('stderr', '');
      duOutput.wo_node = parseSizeSpacePath(r.stdout);
    })
    .then(() => execCommandLine(`du -ab ${rootdir}`))
    .then(r => {
      expect(r).property('stderr', '');
      duOutput.w_node = parseSizeSpacePath(r.stdout);
    })
    .then(() => execCommandLine(`find ${rootdir} -type d -exec stat --printf %s {} ';' -exec echo " "{} ';'`))
    .then(r => {
      expect(r).property('stderr', '');
      findOutput.directories = parseSizeSpacePath(r.stdout);
    })
    .then(() => execCommandLine(`find ${rootdir} -type f -exec stat --printf %s {} ';' -exec echo " "{} ';'`))
    .then(r => {
      expect(r).property('stderr', '');
      findOutput.files = parseSizeSpacePath(r.stdout);
    });
}
