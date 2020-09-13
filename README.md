# action-walk

Minimal utility to walk directory trees performing actions on each directory
entry. `action-walk` has no production dependencies other than
node core modules and has only one strong opinion - don't presume anything
about why the directory tree is being walked.

No presumptions means that this does little more than walk the tree. There
are two options to facilitate implementing your code on top of `action-walk`.
If the boolean option `stat` is truthy `action-walk` will execute `fs.stat`
on the entry and pass that to you action handler. If the option `own` is
present `action-walk` will pass that to the action functions in a context
object.

### usage

`npm install action-walk`

### examples

```
const walk = require('action-walk');

function dirAction (path, context) {
  const {dirent, stat, own} = context;
  if (own.skipDirs && own.skipDirs.indexOf(dirent.name) >= 0) {
    return 'skip';
  }
  own.total += stat.size;
}
function fileAction (path, context) {
  const {stat, own} = context;
  own.total += stat.size;
}

const own = {total: 0, skipDirs: ['node_modules']};
const options = {
  dirAction,
  fileAction,
  own,
  stat: true
};

await walk('.', options);

console.log('total bytes in "."', ctx.total);

// executed in the await-walk package root it will print something like
// total bytes in "." 14778
```

see `test/basics.test.js` for another example.

### api

`await walk(directory, options = {})`

options
- `dirAction` - called for each directory.
- `fileAction` - called for each file.
- `otherAction` - called for non-file, non-directory entries.
- `stat` - call `fs.stat` on the entry and add it to the action context.
- `own` - add this to the action context.

It's possible to call `walk()` with no options but probably not useful unless
all you're wanting to do is seed the disk cache with directory entries. The
action functions are where task-specific work is done.

Each of the action function (`dirAction`, `fileAction`, `otherAction`) is
called with two arguments:
- `filepath` for the entry starting with the `directory`, e.g., if
`directory` is `test` and the entry is `basics.test.js` then `filepath`
will be `test/basics.test.js`. (It is created using node's `path.join` so
note that if `directory` is `.` it will *not* be present in `filepath`.)
- `context` is an object as follows.
```
{
  dirent, // the fs.Dirent object for the directory entry
  stat,   // if `options.stat` the object returned by `fs.stat`
  own     // `options.own` if provided.
}
```

`dirAction` is the only function with return value that matters. If
`dirAction` returns the string `'skip'` (either directly or via a
Promise) then `walk()` will not walk that branch of the directory tree.

All the action functions can return a promise if they need to perform
asynchronous work but only the value of `dirAction` is meaningful.

### todo

- add error handling
- let otherAction return indicator that a symbolic link should be followed.
