{
    let foo;
    const bar = undefined;
    var baz;
}
{
    let foo = "undefined";
    let bar = null;
    let baz = bar ? bar : undefined;
    const {a = null, b = "undefined"} = {};
}

function one(a = undefined, b, c = undefined, d) {}
(function two(a = undefined, ...rest) {});

class Foo {
    prop = undefined;
    method(param = undefined) {}
}

let obj = {
    prop: undefined,
};
