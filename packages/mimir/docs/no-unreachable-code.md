# no-unreachable-code

:mag_right: works better with type information

Disallows statements that will never be executed. Works similar to TypeScript's dead code detection.

Detects executable statements preceded by a statement that definitely ends the control flow, e.g. `return;`.

## Rationale

Code that is not reachable and thus never executed should be removed. It's often not obvious that this code is not executed. That increases complexity and becomes an unnecessary maintenance burden.

Often times code is not made unreachable intentionally. It might be the result of some refactoring or an unnoticed ASI (automatic semicolon insertion) bug.

## Examples

:thumbsdown: Examples of incorrect code

```ts
function foo() {
  return true;
  return false; // unreachable
}

function foo(p: number) {
  if (p) {
    return true;
  } else {
    return false;
  }
  return undefined; // unreachable, both branches of the if statement end control flow
}

function foo() {
  return // semicolon is automatically inserted here
    foo && // unreachable
    bar;
}

function foo() {
  while (true) {
    if (condition)
      continue;
  }
  return false; // unreachable, the loop above never ends
}

for (const key in obj) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    continue;
    console.log('%s is not a own property'); // unreachable, needs to be swapped with the continue
  }
}

// when linting with type information the following patterns are also recognized
declare function fail(): never;

function foo() {
  fail(); // ends control flow by returning 'never'
  console.log('unreachable');
}

function foo(v: boolean) {
  switch (v) {
    case true:
      return 1;
    case false:
      return 2;
  }
  console.log('unreachable'); // switch statement before is exhaustive (handles every possible value), so this statement can never be executed
}
```

:thumbsup: Examples of correct code

```ts
function foo(p: number) {
  if (p)
    return true;
  return false;
}

function foo() {
  return ( // prevent semicolon insertion by adding parens
    foo &&
    bar
  );
}

function foo() {
  while (true) {
    if (conditon)
      break;
  }
  return false;
}

function foo() {
  a = random;
  return a;

  type T = number; // types are not executable and therefore excluded
  var a: T; // this declaration is hoisted and not executable if it has no initializer
  function random() { // function declarations are hoisted and therefore reachable
    return 4;
  }
}
```

## Further Reading

* MDN: [Control flow](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Control_flow_and_error_handling)
* StackOverflow: [What are the rules for JavaScript's automatic semicolon insertion (ASI)?](https://stackoverflow.com/questions/2846283/what-are-the-rules-for-javascripts-automatic-semicolon-insertion-asi)

## Related Rules

* [`no-fallthrough`](no-fallthrough.md)
* [`return-never-call`](return-never-call.md)
