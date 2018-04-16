export class Hello {
    constructor(private world: string) {}
}

export class Hello extends World {
    constructor(private world: string) {
        super();
    }
}

export class Welcome {
    constructor(private home: string = 'mom!') {}
}

export class Hello {
    public hello: string;
    constructor(hello: string = 'mom!') {
        this.hello = hello;
    }
}

export class Hello extends World {
    public hello: string;
    constructor(hello: string = 'mom!') {
        super();
        this.hello = hello;
    }
}

/* Tests for multiple access modifiers */
export class Hello extends World {
    private readonly hello: string;
    constructor(hello: string = 'mom!') {
        super();
        this.hello = hello;
    }
}

export class Hello extends World {
    constructor(private readonly hello: string = 'mom!') {
        super();
    }
}

class Foo {
    fizz: string;
    constructor(fizz: string) {
        this.fizz = fizz + ' buzz';
    }
}

class Foo extends Bar {
    fizz: string;
    constructor(fizz: string) {
        super();
        this.fizz = fizz + ' buzz';
    }
}

/* when-possible config should ignore this case because param is not the first thing to be assigned to the prop */
class Foo {
    fizz: string;
    constructor(fizz: string) {
        this.fizz = 'buzz';
        this.fizz = fizz;
    }
}

class Foo {
    constructor() {}
}

class Foo {
    constructor() { 'use strict'; }
}

class Foo {
    private bar: string;
    constructor(bar: string, private fizz: boolean) {
        this.bar = bar;
    }
}

class Foo {
    private bar: string;
    constructor(bar: string, private fizz: boolean) {
        this.bar = bar + 'fizz';
        this.bar = bar;
    }
}

class Foo {
    private bar: string;
    constructor(bar: string, private fizz?: boolean) {
        this.bar = bar + 'fizz';
        this.bar = bar;
    }
}

/* Need to ignore directives */
class Foo extends Bar {
    private bar: string;
    constructor(bar: string, private fizz?: boolean) {
        'use strict';
        super();
        this.bar = bar + 'fizz';
        this.bar = bar;
    }
}

class Foo extends Bar {
    private bar: string;
    constructor(bar: string, private fizz?: boolean) {
        'use strict';
        super();
        this.bar = bar;
    }
}

class Foo {
    private bar: string;
    constructor(bar: string, private fizz?: boolean) {
        'use strict';
        this.bar = bar;
    }
}

/* When-possible ought to ignore this case */
export class AngularComponent {
    @Input() public data: any;
    constructor(data: any) {
        this.data = data;
    }
}

export class AngularComponent {
    @Input() public data: any;
    constructor(data: any, private foo: string) {
        this.data = data;
    }
}
