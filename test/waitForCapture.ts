export default function waitForCapture(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}
