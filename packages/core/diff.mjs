function markdownLines(markdown) {
  if (markdown === null || markdown === '') return [];
  const lines = markdown.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function diffLines(before, after) {
  const left = markdownLines(before);
  const right = markdownLines(after);
  const result = [];
  let first = 0;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (first < leftEnd && first < rightEnd && left[first] === right[first]) {
    result.push({ type: 'same', text: left[first++] });
  }
  while (leftEnd > first && rightEnd > first && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd--;
    rightEnd--;
  }

  const height = leftEnd - first + 1;
  const width = rightEnd - first + 1;
  if (height > 1 && width > 1 && height * width <= 1_000_000) {
    const lengths = new Uint32Array(height * width);
    for (let i = height - 2; i >= 0; i--) {
      for (let j = width - 2; j >= 0; j--) {
        lengths[i * width + j] = left[first + i] === right[first + j]
          ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < height - 1 || j < width - 1) {
      if (i < height - 1 && j < width - 1 && left[first + i] === right[first + j]) {
        result.push({ type: 'same', text: left[first + i] });
        i++;
        j++;
      } else if (i < height - 1 && (j === width - 1 || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
        result.push({ type: 'removed', text: left[first + i++] });
      } else {
        result.push({ type: 'added', text: right[first + j++] });
      }
    }
  } else {
    // Keep work bounded for large rewrites while preserving exact changed lines.
    for (let i = first; i < leftEnd; i++) result.push({ type: 'removed', text: left[i] });
    for (let j = first; j < rightEnd; j++) result.push({ type: 'added', text: right[j] });
  }
  for (let i = leftEnd; i < left.length; i++) result.push({ type: 'same', text: left[i] });
  return result;
}
