/// <reference types="webpack/module" />

declare const __APP_VERSION__: string;
declare const __APP_REPOSITORY__: string;

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.css';
