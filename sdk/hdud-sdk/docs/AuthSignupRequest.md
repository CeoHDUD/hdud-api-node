
# AuthSignupRequest


## Properties

Name | Type
------------ | -------------
`fullName` | string
`email` | string
`password` | string
`authorCode` | string

## Example

```typescript
import type { AuthSignupRequest } from '@hdud/sdk'

// TODO: Update the object below with actual values
const example = {
  "fullName": Alexandre Neves,
  "email": dba.alexandre.neves@gmail.com,
  "password": SenhaForte#2025,
  "authorCode": ALE-0001,
} satisfies AuthSignupRequest

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as AuthSignupRequest
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


