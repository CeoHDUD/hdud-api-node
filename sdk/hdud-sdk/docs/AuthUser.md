
# AuthUser


## Properties

Name | Type
------------ | -------------
`userId` | number
`email` | string
`createdAt` | Date
`fullName` | string
`authorId` | number
`roles` | Array&lt;string&gt;

## Example

```typescript
import type { AuthUser } from '@hdud/sdk'

// TODO: Update the object below with actual values
const example = {
  "userId": 4,
  "email": null,
  "createdAt": null,
  "fullName": null,
  "authorId": 1,
  "roles": null,
} satisfies AuthUser

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as AuthUser
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


