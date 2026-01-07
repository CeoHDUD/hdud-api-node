
# Memory


## Properties

Name | Type
------------ | -------------
`memoryId` | number
`authorId` | number
`title` | string
`content` | string
`createdAt` | Date
`versionNumber` | number
`isDeleted` | boolean

## Example

```typescript
import type { Memory } from '@hdud/sdk'

// TODO: Update the object below with actual values
const example = {
  "memoryId": 13,
  "authorId": 1,
  "title": null,
  "content": null,
  "createdAt": null,
  "versionNumber": 1,
  "isDeleted": false,
} satisfies Memory

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as Memory
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


