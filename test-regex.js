const text = '```json\n{"foo":"bar"}\n```';
console.log(text.replace(/^```(?:json)?\s*|\s*```$/gi, ''));
