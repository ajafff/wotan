import {A1} from './a1';

export class A {
    nested = new A1();
}
// this fixable failure ensures we only lint this project / file once
debugger;
