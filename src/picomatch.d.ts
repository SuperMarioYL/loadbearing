// picomatch ships no type declarations and the plan pins the package, not
// @types/picomatch. This covers the slice the config loader uses.
declare module "picomatch" {
  export type PicomatchOptions = {
    dot?: boolean;
    nocase?: boolean;
    basename?: boolean;
    nonegate?: boolean;
    noext?: boolean;
  };

  export type Matcher = (input: string, returnObject?: boolean) => boolean;

  export default function picomatch(glob: string | readonly string[], options?: PicomatchOptions): Matcher;
}
