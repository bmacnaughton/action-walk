const fsp = require('fs').promises;
const p = require('path');
const {execCommandLine} = require('./utilities/exec');
const walk = require('../action-walk');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('chai-as-promised'));

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

describe('verify that action-walk works as expected', function () {
  this.timeout(10000);

  // tests need to account for du counting the target directory itself
  // while walk treats that as a starting point and only counts the
  // contents of the directory.
  before(function getTestDirSize () {
    return fsp.stat(testdir)
      .then(s => {
        testdirStat = s;
      });
  })
  before(function getTargetSizes () {
    // output is size-in-bytes <tab> path-starting-with-dir-name
    const p = [
      execCommandLine(`du -ab --exclude=node_modules ${testdir}`),
      execCommandLine(`du -ab ${testdir}`),
      // exclude the directory itself, as action-walk does.
      execCommandLine(`find ${testdir} -type d -mindepth 1 -exec stat --printf %s {} ';' -exec echo " "{} ';'`),
      execCommandLine(`find ${testdir} -type f -exec stat --printf %s {} ';' -exec echo " "{} ';'`),
    ];
    return Promise.all(p)
      .then(r => {
        for (const result of r) {
          expect(result).property('stderr', '');
        }
        duOutput.wo_node = parseSizeSpacePath(r[0].stdout);
        duOutput.w_node = parseSizeSpacePath(r[1].stdout);
        findOutput.directories = parseSizeSpacePath(r[2].stdout);
        findOutput.files = parseSizeSpacePath(r[3].stdout);
      });
  });
  before(function getTargetLinks () {
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

  it('should work with no arguments other than a directory', function () {
    return walk('/dev');
  });

  it('should reject if the argument is not a directory', function () {
    return expect(walk('./package.json')).eventually.rejected;
  })

  it('the directory stack should be correct', function () {
    // this test needs to change if files are added to or removed from
    // the test directory.
    const expected = {
      'basics.test.js':          ['test'],
      'fixtures':                ['test'],
      'fixtures/linked-file.js': ['test', 'fixtures'],
      'utilities':               ['test'],
      'utilities/exec.js':       ['test', 'utilities']
    };
    const prefix = 'test/';

    const action = (path, ctx) => {
      const p = path.slice(path.indexOf(prefix) + prefix.length);
      expect(ctx.stack).deep.equal(expected[p]);
    };

    const options = {
      dirAction: action, fileAction: action, linkAction: action,
    }
    return walk(`${testdir}/test`, options);
  });

  it('should work with non-file, non-directory, non-link file types', function () {
    const options = {
      otherAction: () => options.own.other += 1,
      own: {other: 0},
    };
    return walk('/dev', options)
      .then(() => {
        expect(options.own.other).not.equal(0);
      });
  });

  it('should count the correct number of directories, files, and links', function () {
    let dirCount = 0;
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

  it('du -ab totals should differ by targetsize - linksize using stat', function () {
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
      own : {total: 0},
      stat: true
    };

    return walk(testdir, options)
      .then(() => {
        const awTotal = options.own.total;
        const duTotal = duOutput.w_node[testdir] - testdirStat.size;
        expect(awTotal - duTotal - delta).equal(0, 'du and action-walk should calculate the same total bytes');
      })
  });

  it('should match du -ab output using lstat without a linkAction', function () {
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

  it('should match du -ab --exclude=node_modules', function () {
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

  it('should execute recursively matching du -b', function () {
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

  it('should execute recursively matching du -b --exclude=node_modules', function () {
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

async function daDirsOnly (path, ctx) {
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

function parseSizeSpacePath (text) {
  const o = {};
  const re = /(?<size>\d+)\s+(?<path>.+)/g;
  let m;
  while ((m = re.exec(text))) {
    o[m.groups.path] = +m.groups.size;
  }

  return o;
}

function parseLinkArrowTarget (text) {
  const r = [];
  const re = /(?<target>.+)\s+->\s+(?<link>.+)/g;
  let m;
  while (m = re.exec(text)) {
    r.push({link: m.groups.link, target: m.groups.target})
  }

  return r;
}
