// Small stand-ins for the newest built-ins that pdf.js 6 calls (its modern build expects the latest browsers).
// Each one is added only when the browser lacks it. Loaded before pdf.js on the page and in its worker
// (import/pdf-worker.js), so iPhones a year or two old can read statements too.

if (typeof Promise.try !== "function") {
  Promise.try = function (fn, ...args) {
    return new Promise((resolve) => resolve(fn(...args)));
  };
}
if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    return { promise, resolve, reject };
  };
}
for (const C of [Map, WeakMap]) {
  if (typeof C.prototype.getOrInsertComputed !== "function") {
    Object.defineProperty(C.prototype, "getOrInsertComputed", {
      configurable: true, writable: true,
      value(key, make) {
        if (this.has(key)) return this.get(key);
        const v = make(key);
        this.set(key, v);
        return v;
      },
    });
  }
  if (typeof C.prototype.getOrInsert !== "function") {
    Object.defineProperty(C.prototype, "getOrInsert", {
      configurable: true, writable: true,
      value(key, v) {
        if (this.has(key)) return this.get(key);
        this.set(key, v);
        return v;
      },
    });
  }
}
if (typeof Math.sumPrecise !== "function") {
  // Plain sum with Neumaier compensation: exact enough for page geometry and string lengths.
  Math.sumPrecise = function (items) {
    let sum = 0;
    let c = 0;
    for (const x of items) {
      const t = sum + x;
      c += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
      sum = t;
    }
    return sum + c;
  };
}
if (typeof Uint8Array.fromBase64 !== "function") {
  Uint8Array.fromBase64 = function (s) {
    const bin = atob(String(s).replace(/[\s]/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
}
if (typeof Uint8Array.prototype.toHex !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    configurable: true, writable: true,
    value() {
      let s = "";
      for (const b of this) s += b.toString(16).padStart(2, "0");
      return s;
    },
  });
}
if (typeof Uint8Array.prototype.toBase64 !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    configurable: true, writable: true,
    value() {
      let s = "";
      for (const b of this) s += String.fromCharCode(b);
      return btoa(s);
    },
  });
}
