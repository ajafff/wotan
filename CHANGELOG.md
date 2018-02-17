# Change Log

## v0.1.0

**Features:**

* Enabled nightly builds for all packages. These can be installed with `yarn add @fimbul/wotan@next @fimbul/ve@next ...` (or `npm install` if you prefer).
* `ve`: use SAX parser for performance and avoid false positive matches of `<script>` tags
* `wotan`:
  * New rule `typecheck`: type errors as lint rule failures (similar to `tslint --type-check`, but is correctly formatted and can be ignored like any other rule)
  * New rule `syntaxcheck`: syntax errors as lint rule failures
  * New rule `no-inferred-empty-object`: warns about uninferred type parameters that might cause unintended behavior
  * Introduced `LineSwitchParser` to allow overriding the default line switch handling
  * Introduced `ConfigurationProvider` to allow overriding the default config lookup and parsing
  * Removed implicit configuration lookup in home directory
  * Improved error reporting for errors in configuration files
  * Fail early for circular aliases or missing rulesDirectories in configuration files
  * Allow alias shorthands:
  ```yaml
  overrides:
    prefix:
      name: some-rule-name # same as `name: { rule: some-rule-name }`
  ```
* Added documentation for rule and package authors

**Bugfixes:**

* Include missing declarations in bundled declaration files
* `wotan`:
  * Rule `no-useless-type-assertion` now correctly handles class expressions and qualified type names
  * Detect MPEG TS files and show a warning. Such files are treated as if they were empty.
  * `stylish` formatter correctly displays `line:col` information for files with BOM

## v0.0.1 - Initial Release

**Packages:**

* `@fimbul/wotan`: The main linter runtime with a set of core rules and formatters
  * Available formatters: `json` and `stylish` (default)
  * Available rules:
    * `await-promise` warns about unnecessary await on non-Promise values
    * `deprecation` detects the use of deprecated APIs
    * `no-debugger` bans `debugger;` statements
    * `no-fallthrough` warns about unintentional fallthrough in switch cases
    * `no-return-await` warns about unnecessary `return await foo;` where you can just `return foo;`
    * `no-unsafe-finally` warns about control flow statements within the `finally` block
    * `no-unused-expression` warns about expressions without side-effects whose result is not used
    * `no-unused-label` does what the name suggests, really
    * `no-useless-assertion` detects assertions that don't change the type of the expression
    * `trailing-newline` enforces a line break on the last line of a file
    * `try-catch-return-await` enforces the use of `return await foo;` inside try-catch blocks
* `@fimbul/ve`: The official processor plugin for Vue Single File Components
* `@fimbul/heimdall`: Plugin to enable the use of TSLint rules and formatters within Wotan
* `@fimbul/bifrost`: Allows authors of TSLint rules and formatters to make them available for Wotan without refactoring.
