
# MemoryCreateRequest


## Properties

Name | Type
------------ | -------------
`title` | string
`content` | string

## Example

```typescript
import type { MemoryCreateRequest } from '@hdud/sdk'

// TODO: Update the object below with actual values
const example = {
  "title": Memória com acentuação correta — versão final,
  "content": ÁÉÍÓÚ — memória máquina coração funcionando corretamente.,
} satisfies MemoryCreateRequest

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as MemoryCreateRequest
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


