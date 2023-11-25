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
  wo_node: {},
  w_node: {},
}
const findOutput = {
  links: new Map(),
}

// child_process.execSync('.\\scripts\\file-sizes.ps1', {shell: 'powershell.exe'})

describe('verify that action-walk works as expected', function() {
  // using find to collect all the file and directory sizes is a little
  // bit slow, so give it a minute.
  this.timeout(60000);

  // tests need to account for du counting the target directory itself
  // while walk treats that as a starting point and only counts the
  // contents of the directory.
  before(async function getTestDirSize() {
    let getExpectedValues = isWindows ? getExpectedValuesWin : getExpectedValuesUx;
    return fsp.stat(testdir)
      .then(s => {
        testdirStat = s;
      })
      .then(() => getExpectedValues(duOutput, findOutput));
  })

  before(async function getTargetLinks() {
    return;
    return execCommandLine(`find ${testdir} -type l -exec readlink -nf {} ';' -exec echo " -> "{} ';'`)
      // get object {link: target, ...}
      .then(r => parseLinkArrowTarget(r.stdout))
      .then(async r => {
        for (const pair of r) {
          const link = await (await fsp.lstat(pair.link)).size;
          const target = await (await fsp.stat(pair.target)).size;
          findOutput.links.set(`${pair.link} => ${pair.target}`, {link, target});
        }
      })
  });

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
    const keyCount = prop => Object.keys(findOutput[prop]).length;
    return walk(testdir, options)
      .then(() => {
        expect(dirCount).equal(keyCount('directories'), 'directory counts must match');
        expect(fileCount).equal(keyCount('files'), 'file counts must match');
        expect(linkCount).equal(findOutput.links.size, 'link counts must match');
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
        const target = await fsp.readlink(path);
        const key = `${path} => ${p.resolve(p.dirname(path), target)}`;
        const sizes = findOutput.links.get(key);
        delta += sizes.target - sizes.link;

        ctx.own.total += ctx.stat.size;
      },
      otherAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      own: {total: 0},
      stat: true
    };

    return walk(testdir, options)
      .then(() => {
        const awTotal = options.own.total;
        const duTotal = duOutput.w_node[testdir] - testdirStat.size;
        expect(awTotal - duTotal - delta).equal(0, 'du and action-walk should calculate the same total bytes');
      })
  });

  it('should match du -ab output using lstat without a linkAction', function() {
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
        const duTotal = duOutput.w_node[testdir] - testdirStat.size;
        expect(awTotal - duTotal).equal(0, 'du and action-walk should calculate the same total bytes');
      })
  });

  it('should match du -ab --exclude=node_modules', function() {
    const options = {
      dirAction: (path, {dirent, stat, own}) => {
        if (own.skipDirs && own.skipDirs.indexOf(dirent.name) >= 0) {
          return 'skip';
        }
        own.total += stat.size;
      },
      fileAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      linkAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      own: {total: 0, skipDirs: ['node_modules']},
      stat: 'lstat',
    }

    return walk(testdir, options)
      .then(() => {
        const awTotal = options.own.total;
        const duTotal = duOutput.wo_node[testdir] - testdirStat.size;
        expect(awTotal - duTotal).equal(0, 'du and action-walk should calculate the same total bytes');
      })
  });

  it('should execute recursively matching du -b', function() {
    const own = {total: 0, linkCount: 0, dirTotals: {}, skipDirs: []};
    const options = {
      dirAction: daDirsOnly,
      fileAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      own,
      stat: 'lstat',
    };

    return walk(testdir, options)
      .then(() => {
        expect(own.total + testdirStat.size).equal(duOutput.w_node[testdir]);
        for (const dir in own.dirTotals) {
          expect(own.dirTotals[dir]).equal(duOutput.w_node[`${dir}`]);
        }
      });
  });

  it('should execute recursively matching du -b --exclude=node_modules', function() {
    const own = {total: 0, linkCount: 0, dirTotals: {}, skipDirs: ['node_modules']};
    const options = {
      dirAction: daDirsOnly,
      fileAction: (path, ctx) => ctx.own.total += ctx.stat.size,
      own,
      stat: 'lstat',
    };

    return walk(testdir, options)
      .then(() => {
        expect(own.total + testdirStat.size).equal(duOutput.wo_node[testdir]);
        for (const dir in own.dirTotals) {
          expect(own.dirTotals[dir]).equal(duOutput.wo_node[`${dir}`]);
        }
      });
  });

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

async function getExpectedValuesWin(duOutput, findOutput) {
  let results = cp.spawnSync('.\\scripts\\file-sizes.ps1', ['-nologo'], {shell: 'powershell.exe'});

  let lines1 = results.stdout.toString();
  let lines2 = lines1.split('\n');

  const re = new RegExp('^(\\d+) ' + process.cwd().replace(/\\/g, '\\\\') + '(.+) (True|False)$');
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
      const fullpath = line.slice(m[1].length, -m[3].length);

      w_node[fullpath] = +m[1];
      w_total += w_node[fullpath];
      //w_node.push({size: +m[1], name: m[2], directory: m[3] === 'True'});

      if (!m[2].startsWith('\\node_modules')) {
        wo_node[fullpath] = +m[1];
        wo_total += wo_node[fullpath];
        //wo_node.push({size: +m[1], name: m[2], directory: m[3] === 'True'});
      }


      if (m[3] === 'True') {
        directories[fullpath] = +m[1];
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

async function getExpectedValuesUx(duOutput, findOutput) {
  return execCommandLine(`du -ab --exclude=node_modules ${testdir}`)
    .then(r => {
      expect(r).property('stderr', '');
      duOutput.wo_node = parseSizeSpacePath(r.stdout);
    })
    .then(() => execCommandLine(`du -ab ${testdir}`))
    .then(r => {
      expect(r).property('stderr', '');
      duOutput.w_node = parseSizeSpacePath(r.stdout);
    })
    .then(() => execCommandLine(`find ${testdir} -type d -exec stat --printf %s {} ';' -exec echo " "{} ';'`))
    .then(r => {
      expect(r).property('stderr', '');
      findOutput.directories = parseSizeSpacePath(r.stdout);
    })
    .then(() => execCommandLine(`find ${testdir} -type f -exec stat --printf %s {} ';' -exec echo " "{} ';'`))
    .then(r => {
      expect(r).property('stderr', '');
      findOutput.files = parseSizeSpacePath(r.stdout);
    });
}
