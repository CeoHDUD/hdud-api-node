/* tslint:disable */
/* eslint-disable */

export * from './runtime';

// APIs (export explícito apenas das classes)
export { AuthApi } from './apis/AuthApi';
export { AuthorsApi } from './apis/AuthorsApi';
export { HealthApi } from './apis/HealthApi';
export { MemoriesApi } from './apis/MemoriesApi';

// Models continuam seguros para export *
export * from './models';
