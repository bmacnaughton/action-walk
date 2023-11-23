#!/usr/bin/env node
'use strict';

const util = require('util');
const cp = require('child_process');
const fs = require('fs');
const inquirerPromise = import('inquirer');

// verify that we're in the correct directory by checking package.json
let pdj;
try {
  pdj = fs.readFileSync('package.json', 'utf8');
  pdj = JSON.parse(pdj);
  if (pdj.name !== '@bmacnaughton/action-walk') {
    console.error('package.json name is not @bmacnaughton/action-walk');
    process.exit(1);
  }
} catch (e) {
  if (e.code === 'ENOENT') {
    console.error('package.json not found, must be run from action-walk repository root');
  } else {
    console.error(e.message);
  }
  process.exit(1);
}

// verify the directory is clean (no uncommitted changes, but allow untracked
// files).
verifyCleanDirectory();

const NOISY = process.env.VERBOSE !== 'false' ? console.log : () => null;
// whether to actually execute the commands or just print them. no-push
// executes all commands except those that push to github.
let DRY_RUN = false;
if (process.env.DRY_RUN === 'true') {
  DRY_RUN = true;
} else if (process.env.DRY_RUN === 'no-push') {
  DRY_RUN = 'no-push';
}

const semver = require('semver');
const versionTypes = ['major', 'minor', 'patch'];

// find out what branch we're on.
const currentBranch = execSyncStripOneLine('git branch --show-current');

const questions = [
  {
    // get the branch name to release from; defaults to main.
    name: 'branch',
    message: 'What branch to release (will checkout this branch)?',
    type: 'input',
    default: 'main',
    // this only validates indirectly, by making sure the current branch is
    // the one specified and fetching any remote updates.
    validate: (branch, hash) => {
      if (branch !== currentBranch) {
        cp.execSync(`git checkout ${branch}`);
      }
      // make sure the branch is updated.
      cp.execSync('git pull');

      // get current version after switching to the specified branch
      hash.currentVersion = execSyncStripOneLine('awk -F\\" \'/"version":/ {print $4}\' package.json');
      return true;
    },
  }, {
    // get the type of release (major, minor, patch, custom). incorporate whether
    // we switched to the specific branch or not into the prompt;
    name: 'type',
    message: (hash) => {
      let status;
      if (hash.branch !== currentBranch) {
        status = 'Switched to';
      } else {
        status = 'Using';
      }
      return `[${status} ${hash.branch} (${hash.currentVersion})] New version?`;
    },
    type: 'list',
    choices: (hash) => {
      // the code in default() that makes the choices used to be here. but default()
      // is called before choices() so it has to create them to know what to set the
      // default to.
      return hash._versionChoices;
    },
    // default works with indexes. and it gets called before choices()
    // which makes little sense to me. but that's how it works.
    default(hash) {
      let defaultIx = versionTypes.indexOf('minor');
      const versions = versionTypes.map(type => {
        const versionChoice = semver.inc(hash.currentVersion, type);
        hash.newVersion = versionChoice;
        const name = `${type} (v${versionChoice})`;
        return { name, value: versionChoice, short: name };
      });
      // if there is a prerelease, add it as a choice. we used to use
      // x.y.z-alpha.1 but are switching to x.y.z-alpha where we bump
      // z for each prerelease.
      const preleaseComponents = semver.prerelease(hash.currentVersion);
      if (preleaseComponents) {
        const prerelease = preleaseComponents[0];
        const versionChoice = semver.inc(hash.currentVersion, 'prerelease');
        hash.newVersion = versionChoice;
        const name = `pre${prerelease} (v${versionChoice})`;
        versions.push({ name, value: versionChoice, short: name });
        defaultIx = versions.length - 1;
      }

      versions.push('custom');
      hash._versionChoices = versions;

      return defaultIx;
    },
  }, {
    name: 'custom',
    type: 'input',
    message(hash) {
      return `Custom version number: (current ${hash.currentVersion})?`;
    },
    when: (hash) => hash.type === 'custom',
    validate: (ver, hash) => {
      // eslint-disable-next-line no-cond-assign
      if (ver = semver.valid(ver)) {
        hash.newVersion = ver;
        return true;
      }
      return `Invalid version: \`${ver || 'undefined'}\``;
    },
  }, {
    // whether to return to the original branch after the release is done.
    name: 'back',
    type: 'list',
    choices: ['y', 'n'],
    when(hash) {
      return hash.branch !== currentBranch;
    },
    filter(back, _hash) {
      return back === 'y';
    },
    message(_hash) {
      return `Return to ${currentBranch} after submission?`;
    },
  },
];

/*
 * Execute release steps
 *
 * This counts on npm access token being setup - use granular permissions
 * https://httptoolkit.com/blog/automatic-npm-publish-gha/
 *
 * command records the last command executed so that if there's an error,
 * the message can be more helpful.
 */
let command;

inquirerPromise
  .then(inquirer =>
    inquirer.default.prompt(questions))
  .then(hash => {
    NOISY(`[${util.inspect(hash)}]`);
    return hash;
  })
  .then(hash => {
    const branchName = `release/v${hash.newVersion}`;
    const commands = [
      // branch checkout was done as part of the questions so the current
      // version could be read.
      //
      // git create branch of format release/<version>
      `git checkout -b ${branchName}`,
      // npm version (should create git tag and commit package.json, but
      // it doesn't when .git directory and package.json are in different
      // directories. so do each step manually.
      // https://stackoverflow.com/questions/75965870/npm-version-command-not-creating-git-tag-when-the-npm-app-is-in-a-sub-folder
      `npm version ${hash.newVersion}`,
      // commit package.json (we verified the directory was clean earlier)
      `git commit -am "release: v${hash.newVersion}"`,
      // tag the commit
      `git tag v${hash.newVersion} -m "release: v${hash.newVersion}"`,
      // push it to github
      `git push -u origin ${branchName}`,
      // and push the tag too
      `git push origin refs/tags/v${hash.newVersion}`,
    ];
    for (const cmd of commands) {
      if (DRY_RUN === true || DRY_RUN === 'no-push' && cmd.startsWith('git push')) {
        console.log('->dry_run:', cmd);
        continue;
      }
      command = cmd;
      execute(cmd);
    }

    return hash;
  })
  .then(hash => {
    if (hash.back && hash.branch !== currentBranch) {
      execute(`git checkout ${currentBranch}`);
    }
  })
  .catch((err) => {
    console.log('Making release failed:');
    const {stdout, stderr} = err;
    console.log(err.message, err.status);
    if (stdout.length) {
      console.log('stdout', stdout.toString());
    }
    if (stderr) {
      console.log('stderr', stderr.toString());
    }
    if (command.startsWith('git checkout -b')) {
      console.log('Creating the branch failed; you may need delete the release branch');
    } else if (command.startsWith('npm version')) {
      console.log('npm version failed; you may need to delete the tag or clean the directory');
    } else if (command.startsWith('git push -u origin')) {
      console.log('git push failed; you may need to delete the branch');
    } else if (command.startsWith('git push origin')) {
      console.log('git push tag failed; you should manually fix it');
    }

    if (!command.startsWith('git checkout -b')) {
      console.log('you should delete the release branch');
    }
  });

// a little helper
function execute(cmd, message = '') {
  if (message) {
    NOISY(message);
  } else {
    NOISY(`[exec: ${cmd}]`);
  }

  cp.execSync(cmd);
}

function execSyncStripOneLine(cmd, message = '') {
  if (message) {
    NOISY(message);
  } else {
    NOISY(`[exec: ${cmd}]`);
  }

  const response = cp.execSync(cmd).toString();
  if (response.indexOf('\n') >= 0) {
    return response.split('\n')[0];
  }
  return response;
}

function verifyCleanDirectory() {
  const stdout = cp.execSync('git status --porcelain=v2').toString();
  const lines = stdout.toString().split('\n');
  for (const line of lines) {
    // it doesn't appear that "!" is used; the docs say ignored files are
    // flagged with a "!" but that doesn't seem to be the case.
    if (line && !line.startsWith('?') && !line.startsWith('!')) {
      throw new Error('Directory is not clean');
    }
  }
}
