declare module "*.mjs" {
  export function createRawScanner(sane: any, options?: any): any;
}
declare module "*.css";
interface Window { LibSANE?: (options: any) => Promise<any>; receiptSane?: any; }
interface Navigator { usb: { requestDevice(options: unknown): Promise<{ vendorId: number; productId: number }> }; }
