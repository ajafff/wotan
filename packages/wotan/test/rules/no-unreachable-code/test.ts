if (true) {
    'foo';
} else {
    'bar';
}

if (true) {
    'foo';
}

if (false) {}

if (false) {
    'foo';
} else {
    'bar';
}

while (false) {
    {
    }
    {
        ;
        'foo';
    }
}

for (;false;) 'foo';

do 'foo'; while (false);

function test() {
    outer: while (true) {
        inner: do {
            break outer;
        } while (true);
        'bar';
    }

    outer: while (true) {
        inner: do {
            continue outer;
        } while (true);
        'foo';
    }
    var a;
    let b;
}

function test2() {
    while (true)
        break;
    if (false) {
        var a, b = 1;
    } else {
        return;
    }
    type T = any;
    var a, b: string;
    function foo() {}
    interface Foo {}
    const enum E {}
    enum E2 {}
    return true;
}

function test3() {
    const condition: true = true;
    while (condition) {
        'foo';
    }
    'bar';
    if (condition) {
        'baz';
    } else {
        'baz';
    }

    for (;;);
    'foobar';
}

function test4() {
    return;
}
