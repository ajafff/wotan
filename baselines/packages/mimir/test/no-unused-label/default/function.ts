bar: for (;;) {
    let fn = function foo() {
        while (true)
            break foo;
    }
    continue bar;
}
