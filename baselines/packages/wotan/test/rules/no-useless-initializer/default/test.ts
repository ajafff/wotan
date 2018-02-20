{
    let foo;
    const bar = undefined;
    var baz;
}
{
    // TODO these need the type checker
    let {a = undefined, b = undefined} = {a: 1}; // a useless, b necessary
    const {c = undefined} = {}; // necessary
    let v = Boolean() ? {d: 1} : {};
    const {d = undefined} = v; // useless
    const {e = undefined} = Boolean() ? {e: 1} : {}; // necessary
    ({a = undefined, b = undefined} = {a}); // a useless, b necessary
    // TODO array destructuring should be handled, too
}
{
    let foo = "undefined";
    let bar = null;
    let baz = bar ? bar : undefined;
    let bas = undefined!;
    const {a = null, b = "undefined"} = {};
}

function one(a: string | undefined, b: string, c?: any, d?: number) {}
(function two(a?: string, b = 1, ...rest: string[]) {});

type undef = undefined;
function three(a?: boolean | undef) {}

let fn: typeof three = (a?) => {};

class Foo {
    prop = undefined;
    prop2: string | undefined = undefined;

    method(param?) {}

    constructor(private prop3?: string) {}
}

let obj = {
    prop: undefined,
};
