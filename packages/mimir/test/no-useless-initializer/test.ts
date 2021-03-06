{
    let foo = undefined;
    const bar = undefined;
    var baz = undefined;
}
{
    // TODO these need more accurate types from the type checker
    let {a = undefined, b = undefined} = {a: 1}; // a useless, b necessary
    const {c = undefined} = {}; // necessary
    let v = Boolean() ? {d: 1} : {};
    const {d = undefined} = v; // useless
    let {e = undefined} = Boolean() ? {e: 1} : {}; // necessary
    ({a = undefined, b = undefined} = {a}); // a useless, b necessary
}
{
    let rest, a: number | undefined, b: number | undefined, e: number | undefined;
    const tuple: [number, number?] = [1, 2];
    [a = 1, e = 2] = tuple;
    [, a = 1, ...rest] = [1, 2];
    [a = 1, b = undefined ] = [1];
    [a = 1] = rest;
}
{
    let foo = "undefined";
    let bar = null;
    let baz = bar ? bar : undefined;
    let bas = undefined!;
    const {a = null, b = "undefined"} = {};
}

function one(a: string | undefined = undefined, b: string, c: any = undefined, d?: number) {}
(function two(a: undefined | string = undefined, b = 1, ...rest: string[]) {});

type undef = undefined;
function three(a: boolean | undef = undefined) {}

let fn: typeof three = (a = undefined) => {};

class Foo {
    prop = undefined;
    prop2: string | undefined = undefined;

    method(param = undefined) {}

    constructor(private prop3: string | undefined = undefined) {}
}

let obj = {
    prop: undefined,
};

declare function get<T>(): T;

{
    let {prop = 'foo'} = obj;
    let {foo = 'foo'} = {foo: 'foo'};
    let {bar = 'bar'} = Boolean() ? {bar: 'bar'} : {};
    let {baz = 'baz'} = Boolean() ? {baz: 'baz'} : {baz: undefined};
    let {bas = 'bas'} = Boolean() ? {bas: 'bas'} : {bas: 'foobas'};
}
{
    let obj = {
        prop: 'foo',
    };
    let {['prop']: noDefault} = obj;
    let {prop = 'foo'} = obj;
    let {foo = 'oof'} = get<{foo: 'foo'}>();
    let {foo2 = null as any} = get<{foo2: 'foo'}>();
    let {foo3 = null as unknown} = get<{foo3: 'foo'}>();
    let {bar = 'bar'} = get<{bar?: 'bar'}>();
    let {baz = 'baz'} = get<{baz: 'baz'} | {baz: undefined}>();
    let {bas = 'bas'} = get<{bas: 'bas'} | {bas: 'foobas'}>();
    let {something = 'something'} = get<{[key: string]: string}>();
    let {any = 'any'} = get<{any: any}>();
    let {unknown = 'unknown'} = get<{unknown: unknown}>();
    let {'prop': renamed = 'renamed'} = obj;
    const propName = 'prop';
    const {[propName]: computed = null} = obj;
    const propName2: string = null as any;
    let {[propName2]: computed2 = ''} = get<{[key: string]: string}>();
    const propName3 = 1;
    const {[propName3]: computed3 = null} = get<{1: string, 2: string}>();
    const {[Symbol.iterator]: iterator = () => get<IterableIterator<string>>()} = [1];
    let {nested: {prop: nestedProp = 'nestedProp'} = obj} = get<{nested: typeof obj}>();
    let {toString = () => 'foo'} = 1;

    ({toString = () => 'foo'} = 2);

    ({prop} = obj);
    ({prop = ''} = {prop: 'foo'});
    ({prop = ''} = obj);
    ({'prop': prop = ''} = obj);
    ({prop = ''} = {});
    ({prop: prop = ''} = get<typeof obj>());
    ({prop: prop} = get<typeof obj>());
    ({prop = ''} = get<{prop?: string}>());
    ({...{}} = obj);
}
{
    let [one = '', two = '', , four = ''] = get<string[]>();
    let [,, three = ''] = get<Array<string | undefined>>();
    let [a = '', b = 1, c = true] = get<[string, number, boolean]>();
    let [d = '', e = 1, f = true] = get<[string | undefined, number | undefined, boolean | undefined]>();
    let [g = '', h = 1, i = true] = get<[string, number, boolean] | [number, undefined, undefined]>();
    let [first = 2, second = 3, third = 1] = [1, undefined];
}
{
    let {0: first = 1, 1: second = 2, length = 1} = [1];
    let {0: a = 1, 1: b = 2} = get<[number]>();
    let {0: c = 1, 1: d = 2} = get<[number, number]>();
}

function test<T, U extends any, V extends T, W extends string, X extends boolean | undefined>(param: {t: T, u: U, v: V, w: W, x: X}) {
    let {t = '', u = '', v = '', w = '', x = ''} = param;
    let {wx = ''} = get<{wx: W | X}>();
}

function test2<T>(t: T, u: T extends string ? boolean : undefined, v: T extends string ? string : boolean, w: T extends string ? T : number) {
    let {t: _t = '', u: _u = '', v: _v = '', w: _w = ''} = get<{t: typeof t, u: typeof u, v: typeof v, w: typeof w}>();
}
