import test from 'ava';
import {
    calculateChangeRange,
    resolveCachedResult,
} from '../src/utils';

test('calculateChangeRange', (t) => {
    assertRange('', 'a', 0, 0, 1);
    assertRange('a', '', 0, 1, 0);
    assertRange('aabbcc', 'aaabbbccc', 2, 2, 5);
    assertRange('aaabbbccc', 'aabbcc', 2, 5, 2);
    assertRange('aabbcc', 'aaabbbcdc', 2, 3, 6);
    assertRange('abc', 'axbc', 1, 0, 1);
    assertRange('abc', 'ac', 1, 1, 0);
    assertRange('abc', 'c', 0, 2, 0);
    assertRange('abc', 'abcd', 3, 0, 1);
    assertRange('abc', 'axc', 1, 1, 1);
    assertRange('abc', 'xyz', 0, 3, 3);
    assertRange('abababab', 'abababab', 8, 0, 0);
    assertRange('abababab', 'ababab', 6, 2, 0);
    assertRange('ababab', 'abababab', 6, 0, 2);
    assertRange('abababab', 'ababcabab', 4, 0, 1);

    function assertRange(original: string, changed: string, start: number, length: number, newLength: number) {
        t.is(newLength, length + changed.length - original.length);
        t.deepEqual(
            calculateChangeRange(original, changed),
            {
                newLength,
                span: {
                    start,
                    length,
                },
            },
        );
        t.deepEqual(
            calculateChangeRange(changed, original), {
                span: {
                    start,
                    length: newLength,
                },
                newLength: length,
            },
        );
    }
});

test('resolveCachedResult', (t) => {
    const cache = new Map<string, string | undefined>();
    t.is(
        resolveCachedResult(cache, 'a', (key) => {
            t.is(key, 'a');
            return undefined; // tslint:disable-line
        }),
        undefined,
    );
    t.is(cache.size, 1);
    t.true(cache.has('a'));
    t.is(cache.get('a'), undefined);
    t.is(resolveCachedResult(cache, 'a', () => { throw new Error('should not be called'); }), undefined);

    t.is(
        resolveCachedResult(cache, 'b', (key) => {
            t.is(key, 'b');
            return 'foo';
        }),
        'foo',
    );
    t.is(cache.size, 2);
    t.true(cache.has('b'));
    t.is(cache.get('b'), 'foo');
    t.is(resolveCachedResult(cache, 'b', () => { throw new Error('should not be called'); }), 'foo');

    cache.set('c', 'bar');
    t.is(resolveCachedResult(cache, 'c', () => { throw new Error('should not be called'); }), 'bar');
});
