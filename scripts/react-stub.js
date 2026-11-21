// cdp-core's zustand import pulls zustand/react; the vanilla store is all we use, so React is never called.
const no = () => { throw new Error("React is not available"); };
export const useSyncExternalStore = no, useDebugValue = () => {}, useCallback = (f) => f, useMemo = (f) => f(), useRef = no, useEffect = no, useState = no, createContext = no, useContext = no;
export default { useSyncExternalStore, useDebugValue, useCallback, useMemo, useRef, useEffect, useState, createContext, useContext };
