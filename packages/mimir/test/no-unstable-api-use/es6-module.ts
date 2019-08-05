/** File header. Some declarations in this file are @deprecated */

/** docs */
export const x = 1;
/** @deprecated */
export const y = 1;

/** @deprecated */
const v = 1;
export default v;

export { // exporting deprecated stuff is not that bad, using it after importing is
    v,
    v as something,
};

/** @deprecated */
export namespace ns {
    export interface I {}
    /** @deprecated */
    export interface D {}
}
