
# AuthAuthor


## Properties

Name | Type
------------ | -------------
`authorId` | number
`authorCode` | string
`fullName` | string
`createdAt` | Date

## Example

```typescript
import type { AuthAuthor } from '@hdud/sdk'

// TODO: Update the object below with actual values
const example = {
  "authorId": 1,
  "authorCode": ALE-0001,
  "fullName": null,
  "createdAt": null,
} satisfies AuthAuthor

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as AuthAuthor
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


