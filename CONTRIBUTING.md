# Contributing to OpenGov MCP Server

Thank you for your interest in contributing to OpenGov MCP Server! This project enables MCP clients like Claude Desktop to access open government data through Socrata APIs.

## Getting Started

### Development Environment Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/yourusername/opengov-mcp-server.git
   cd opengov-mcp-server
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure a data portal**:
   Create a `.env` file in the root directory:
   ```
   DATA_PORTAL_URL=https://data.cityofchicago.org
   ```
   You can use any Socrata-powered data portal.

4. **Build and run**:
   ```bash
   npm run build
   npm start
   ```

### Testing Your Changes

Test your changes by interacting with the server through Claude Desktop:

1. Build the project with your changes
2. Update your Claude Desktop config to point to your development version
3. Check that Claude Desktop can successfully interact with the server

## Project Structure

- `src/index.ts` - MCP server initialization and request handling
- `src/tools/socrata-tools.ts` - The unified `get_data` tool implementation
- `src/utils/` - Helper functions and type definitions
- `src/__tests__/` - Test files

## Testing

We use Vitest for testing:

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run a specific test file
npx vitest run src/__tests__/filename.test.ts
```

## Code Style

We follow standard TypeScript best practices:

- Use TypeScript with strict typing
- Format with Prettier: `npm run format`
- Lint with ESLint: `npm run lint`
- Use async/await for asynchronous operations
- Follow consistent error handling patterns

## Pull Request Guidelines

1. **Focus on a single concern**: Each PR should address one feature, improvement, or bugfix.

2. **Include tests**: Add tests that cover your changes.

3. **Update documentation**: Keep the README and code comments up to date.

4. **Follow the existing style**: Match the code style of the project.

5. **Keep PRs small and focused**: Smaller, targeted PRs are easier to review and merge.

## Feature Requests and Bug Reports

Use the GitHub issue tracker to submit:

- **Bug reports**: Include clear steps to reproduce, expected vs. actual behavior
- **Feature requests**: Explain the use case and benefits clearly

## Areas for Contribution

Here are some areas where contributions would be particularly valuable:

- Support for additional Socrata API features
- Performance improvements
- Better error handling and reporting
- Additional example use cases
- Improved documentation

## License

By contributing to this project, you agree that your contributions will be licensed under the project's MIT License.