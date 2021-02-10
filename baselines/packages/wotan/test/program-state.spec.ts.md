# Snapshot report for `packages/wotan/test/program-state.spec.ts`

The actual snapshot is saved in `program-state.spec.ts.snap`.

Generated by [AVA](https://avajs.dev).

## saves old state

> Snapshot 1

    `cs: false␊
    files:␊
      - config: '1234'␊
        hash: '-2704852577'␊
        result: []␊
      - config: '1234'␊
        dependencies:␊
          ./c:␊
            - 0␊
        hash: '-5185547329'␊
        result: []␊
      - dependencies:␊
          ./c:␊
            - 0␊
        hash: '-5185547329'␊
      - dependencies:␊
          ./b:␊
            - 1␊
          ./d:␊
            - 2␊
        hash: '-2126001415'␊
    global: []␊
    lookup:␊
      a.ts: 3␊
      b.ts: 1␊
      c.ts: 0␊
      d.ts: 2␊
    options: '-1350339532'␊
    v: 1␊
    `

> Snapshot 2

    `cs: false␊
    files:␊
      - config: '1234'␊
        hash: '-2704852577'␊
        result: []␊
      - config: '1234'␊
        dependencies:␊
          ./c:␊
            - 0␊
        hash: '-5185547329'␊
        result: []␊
      - dependencies:␊
          "\\0":␊
            - 3␊
        hash: '5381'␊
      - dependencies:␊
          ./e:␊
            - 2␊
            - 3␊
        hash: '910822549'␊
      - dependencies:␊
          ./b:␊
            - 1␊
          ./d:␊
            - 3␊
        hash: '-2126001415'␊
    global: []␊
    lookup:␊
      a.ts: 4␊
      b.ts: 1␊
      c.ts: 0␊
      d.ts: 3␊
      e.ts: 2␊
    options: '-1350339532'␊
    v: 1␊
    `

> Snapshot 3

    `cs: false␊
    files:␊
      - hash: '-2704852577'␊
      - dependencies:␊
          ./c:␊
            - 0␊
        hash: '-5185547329'␊
      - dependencies:␊
          "\\0":␊
            - 3␊
          e: null␊
        hash: '8844149038'␊
      - dependencies:␊
          ./e:␊
            - 2␊
            - 3␊
        hash: '910822549'␊
      - dependencies:␊
          ./b:␊
            - 1␊
          ./d:␊
            - 3␊
        hash: '-2126001415'␊
    global:␊
      - 2␊
    lookup:␊
      a.ts: 4␊
      b.ts: 1␊
      c.ts: 0␊
      d.ts: 3␊
      e.ts: 2␊
    options: '-1350339532'␊
    v: 1␊
    `

## doesn't discard results from old state

> Snapshot 1

    `cs: false␊
    files:␊
      - config: '1234'␊
        hash: '-3360789062'␊
        result: []␊
      - config: '1234'␊
        hash: '574235295'␊
        result: []␊
      - dependencies:␊
          ./c:␊
            - 1␊
        hash: '-5185547329'␊
    global:␊
      - 1␊
    lookup:␊
      a.ts: 0␊
      b.ts: 2␊
      c.ts: 1␊
    options: '5864093'␊
    v: 1␊
    `

> Snapshot 2

    `cs: false␊
    files:␊
      - hash: '-3360789062'␊
      - hash: '4830905933'␊
      - dependencies:␊
          ./c:␊
            - 1␊
        hash: '-5185547329'␊
    global:␊
      - 1␊
    lookup:␊
      a.ts: 0␊
      b.ts: 2␊
      c.ts: 1␊
    options: '5864093'␊
    v: 1␊
    `