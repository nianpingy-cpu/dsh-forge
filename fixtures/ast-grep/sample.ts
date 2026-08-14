function processData(items: string[], options: Options): Result {
  return transform(items, options);
}

const value = transform(data, config);
export { processData };
