declare let x: Promise<string>;
function notAsync() {
    return;
    return x;
    try {
        return x;
    } catch {
        return x;
    } finally {
        return x;
    }
}
async function test() {
    return x;
    try {
        return;
        return x;
        function nestedFn() {
            return x;
        }
        return await x;
        return (x);
        return (
            await x
        );
        return {
            fn() {
                return x;
            },
            get x() {
                return x;
            },
            async asyncFn() {
                return x;
            },
        };
        return await x || x;
        return x || await x;
        return (x || await x);
        return x && await x;
        return Boolean() ? x : x;
        return(Boolean() ? await x : x);
        return Boolean() ? x : await x;
        {
            for (;;) {
                return x;
            }
        }
        return (async () => {
            try {
                return x;
            } catch {
                return x;
            }
        })();
    } catch {
        return x;
    } finally {
        return x;
    }
    try {
        return x;
    } finally {
        return x;
    }
    try {
        return x;
        try {
            return x;
        } catch {
            return x;
        }
        return x;
        try {
            return x;
        } finally {
            return x;
        }
        return x;
    } catch {
        return x;
        try {
            return x;
        } catch {
            return x;
        }
        return x;
    }
    function nested() {
        try {
            return x;
        } catch {
            return x;
        }
    }
    return {
        get foo() {
            try {
                return x;
            } catch {
                return x;
            }
        }
    }
}

try {
    return x;
} catch {
}

async function testStatements() {
    try {
        label: if (Boolean())
            return x;
        switch (Boolean()) {
            case true:
                if (Boolean()) {
                    return x;
                } else {
                    return x;
                }
            default:
                while (true)
                    return x;
        }
    } catch (e) {}
}
