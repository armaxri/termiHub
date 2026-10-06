/**
 * Side-effect entry for {@link installStyleNonce} (#3115). `main.tsx` imports
 * this ahead of every module that may create a `<style>` element while it is
 * evaluated, so those elements carry the page's CSP nonce.
 */
import { installStyleNonce } from "./styleNonce";

installStyleNonce();
