declare let obj: Record<string, any>;

obj.foo;
obj.bar.baz;
obj.__foo__;
obj.fooBar;

obj[''];
obj['1'];
obj['.'];
obj[','];
obj[' '];
obj['foo-bar'];
obj['foo' + 'bar'];
obj[`foo${1}`];
obj[];

for (const key of Object.keys(obj))
    obj[key];

['foo'];

type T = string[]['length'];
type V = string['charCodeAt'];
