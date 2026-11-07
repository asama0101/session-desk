// テストの待ち（setTimeout）の型。tsconfig の lib に入っていないので、ここで宣言する。
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number): unknown
