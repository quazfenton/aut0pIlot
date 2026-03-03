import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Use full git path for Windows
const GIT_PATH = 'C:\\Program Files\\Git\\cmd\\git.exe';

describe('Integration Tests - End-to-End Scenarios', () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'));
    repoDir = path.join(tempDir, 'test-repo');
    
    fs.mkdirSync(repoDir, { recursive: true });
    execSync(`"${GIT_PATH}" init`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${GIT_PATH}" config user.email "test@test.com"`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${GIT_PATH}" config user.name "Test"`, { cwd: repoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  function createProjectStructure(): void {
    // Create a realistic project structure
    const files = {
      'package.json': JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        scripts: {
          test: 'vitest',
          build: 'tsc'
        },
        dependencies: {
          react: '^18.0.0',
          'react-dom': '^18.0.0'
        },
        devDependencies: {
          typescript: '^5.0.0',
          vitest: '^1.0.0'
        }
      }, null, 2),

      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'commonjs',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true
        },
        include: ['src/**/*'],
        exclude: ['node_modules', 'dist']
      }, null, 2),

      'src/index.ts': `import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  root.render(App());
}`,

      'src/App.tsx': `import React, { useState } from 'react';
import { Button } from './components/Button';
import { UserList } from './components/UserList';

interface User {
  id: number;
  name: string;
  email: string;
}

export const App: React.FC = () => {
  const [users, setUsers] = useState<User[]>([
    { id: 1, name: 'John Doe', email: 'john@example.com' },
    { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
  ]);

  const addUser = () => {
    const newUser: User = {
      id: users.length + 1,
      name: \`User \${users.length + 1}\`,
      email: \`user\${users.length + 1}@example.com\`
    };
    setUsers([...users, newUser]);
  };

  return (
    <div className="app">
      <h1>User Management</h1>
      <Button onClick={addUser}>Add User</Button>
      <UserList users={users} />
    </div>
  );
};`,

      'src/components/Button.tsx': `import React from 'react';

interface ButtonProps {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

export const Button: React.FC<ButtonProps> = ({
  onClick,
  children,
  disabled = false,
  className = ''
}) => {
  return (
    <button
      className={\`btn \${className}\`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
};`,

      'src/components/UserList.tsx': `import React from 'react';

interface User {
  id: number;
  name: string;
  email: string;
}

interface UserListProps {
  users: User[];
}

export const UserList: React.FC<UserListProps> = ({ users }) => {
  const deleteUser = (id: number) => {
    // This should be implemented
    console.log('Delete user:', id);
  };

  return (
    <ul className="user-list">
      {users.map(user => (
        <li key={user.id} className="user-item">
          <span>{user.name} ({user.email})</span>
          <button onClick={() => deleteUser(user.id)}>
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
};`,

      'src/styles.css': `body {
  font-family: Arial, sans-serif;
  margin: 0;
  padding: 20px;
}

.app {
  max-width: 800px;
  margin: 0 auto;
}

.btn {
  background-color: #007bff;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
}

.btn:hover {
  background-color: #0056b3;
}

.user-list {
  list-style: none;
  padding: 0;
}

.user-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px;
  border-bottom: 1px solid #eee;
}`,

      'vitest.config.ts': `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom'
  }
});`
    };

    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(repoDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }

    // Initial commit
    execSync(`"${GIT_PATH}" add .`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${GIT_PATH}" commit -m "Initial project setup"`, { cwd: repoDir, stdio: 'ignore' });
  }

  describe('Real PR Scenarios', () => {
    it('should handle React component refactoring', () => {
      createProjectStructure();

      // Simulate a PR that refactors the Button component
      const patch = `--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -1,21 +1,35 @@
 import React from 'react';
 
 interface ButtonProps {
   onClick: () => void;
   children: React.ReactNode;
   disabled?: boolean;
   className?: string;
+  variant?: 'primary' | 'secondary' | 'danger';
+  size?: 'small' | 'medium' | 'large';
 }
 
 export const Button: React.FC<ButtonProps> = ({
   onClick,
   children,
   disabled = false,
-  className = ''
+  className = '',
+  variant = 'primary',
+  size = 'medium'
 }) => {
+  const getVariantClass = () => {
+    switch (variant) {
+      case 'secondary':
+        return 'btn-secondary';
+      case 'danger':
+        return 'btn-danger';
+      default:
+        return 'btn-primary';
+    }
+  };
+
+  const getSizeClass = () => {
+    switch (size) {
+      case 'small':
+        return 'btn-small';
+      case 'large':
+        return 'btn-large';
+      default:
+        return 'btn-medium';
+    }
+  };
+
   return (
     <button
-      className={\`btn \${className}\`}
+      className={\`btn \${getVariantClass()} \${getSizeClass()} \${className}\`}
       disabled={disabled}
       onClick={onClick}
     >
       {children}
     </button>
   );
 };`;

      const patchFile = path.join(tempDir, 'button-refactor.patch');
      fs.writeFileSync(patchFile, patch);

      const result = execSync(`"${GIT_PATH}" apply "${patchFile}"`, {
        cwd: repoDir,
        stdio: 'pipe'
      });

      // Verify the patch was applied correctly
      const updatedContent = fs.readFileSync(path.join(repoDir, 'src/components/Button.tsx'), 'utf8');
      expect(updatedContent).toContain('variant?:');
      expect(updatedContent).toContain('size?:');
      expect(updatedContent).toContain('getVariantClass');
      expect(updatedContent).toContain('getSizeClass');
    });

    it('should handle multi-file feature addition', () => {
      createProjectStructure();

      // Simulate adding a new feature with multiple files
      const multiFilePatch = `--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1,28 +1,35 @@
 import React, { useState } from 'react';
 import { Button } from './components/Button';
 import { UserList } from './components/UserList';
+import { SearchBar } from './components/SearchBar';
 
 interface User {
   id: number;
   name: string;
   email: string;
+  department?: string;
 }
 
 export const App: React.FC = () => {
   const [users, setUsers] = useState<User[]>([
     { id: 1, name: 'John Doe', email: 'john@example.com' },
-    { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
+    { id: 2, name: 'Jane Smith', email: 'jane@example.com', department: 'Engineering' }
   ]);
 
   const addUser = () => {
     const newUser: User = {
       id: users.length + 1,
       name: \`User \${users.length + 1}\`,
-      email: \`user\${users.length + 1}@example.com\`
+      email: \`user\${users.length + 1}@example.com\`,
+      department: 'General'
     };
     setUsers([...users, newUser]);
   };
 
+  const filteredUsers = users.filter(user => 
+    user.name.toLowerCase().includes('') || // Search term would go here
+    user.email.toLowerCase().includes('')
+  );
+
   return (
     <div className="app">
       <h1>User Management</h1>
+      <SearchBar onSearch={(term) => console.log('Search:', term)} />
       <Button onClick={addUser}>Add User</Button>
-      <UserList users={users} />
+      <UserList users={filteredUsers} />
     </div>
   );
 };

--- /dev/null
+++ b/src/components/SearchBar.tsx
@@ -0,0 +1,25 @@
+import React, { useState } from 'react';
+
+interface SearchBarProps {
+  onSearch: (term: string) => void;
+}
+
+export const SearchBar: React.FC<SearchBarProps> = ({ onSearch }) => {
+  const [searchTerm, setSearchTerm] = useState('');
+
+  const handleSubmit = (e: React.FormEvent) => {
+    e.preventDefault();
+    onSearch(searchTerm);
+  };
+
+  return (
+    <form onSubmit={handleSubmit} className="search-bar">
+      <input
+        type="text"
+        placeholder="Search users..."
+        value={searchTerm}
+        onChange={(e) => setSearchTerm(e.target.value)}
+      />
+      <button type="submit">Search</button>
+    </form>
+  );
+};

--- a/src/styles.css
+++ b/src/styles.css
@@ -40,3 +40,15 @@
 .user-item {
   display: flex;
   justify-content: space-between;
   align-items: center;
   padding: 8px;
   border-bottom: 1px solid #eee;
 }
+
+.search-bar {
+  display: flex;
+  gap: 8px;
+  margin-bottom: 20px;
+}
+
+.search-bar input {
+  flex: 1;
+  padding: 8px;
+  border: 1px solid #ddd;
+  border-radius: 4px;
+}`;

      const patchFile = path.join(tempDir, 'feature-addition.patch');
      fs.writeFileSync(patchFile, multiFilePatch);

      // Apply the patch
      const result = execSync(`"${GIT_PATH}" apply "${patchFile}"`, {
        cwd: repoDir,
        stdio: 'pipe'
      });

      // Verify all changes were applied
      expect(fs.existsSync(path.join(repoDir, 'src/components/SearchBar.tsx'))).toBe(true);
      
      const updatedApp = fs.readFileSync(path.join(repoDir, 'src/App.tsx'), 'utf8');
      expect(updatedApp).toContain('SearchBar');
      expect(updatedApp).toContain('filteredUsers');
      expect(updatedApp).toContain('department?:');

      const updatedStyles = fs.readFileSync(path.join(repoDir, 'src/styles.css'), 'utf8');
      expect(updatedStyles).toContain('.search-bar');
    });

    it('should handle bug fix patches', () => {
      createProjectStructure();

      // Simulate a bug fix for the UserList delete functionality
      const bugFixPatch = `--- a/src/App.tsx
+++ b/src/App.tsx
@@ -4,6 +4,7 @@ import { Button } from './components/Button';
 import { UserList } from './components/UserList';
 
 export const App: React.FC = () => {
+  const [users, setUsers] = useState<User[]>([
+    { id: 1, name: 'John Doe', email: 'john@example.com' },
+    { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
+  ]);
+
   const addUser = () => {
     const newUser: User = {
       id: users.length + 1,
@@ -11,11 +12,8 @@ export const App: React.FC = () => {
     };
     setUsers([...users, newUser]);
   };
-
-  return (
-    <div className="app">
-      <h1>User Management</h1>
-      <Button onClick={addUser}>Add User</Button>
-      <UserList users={users} />
-    </div>
-  );
 };

--- a/src/components/UserList.tsx
+++ b/src/components/UserList.tsx
@@ -1,22 +1,25 @@
 import React from 'react';
 
 interface User {
   id: number;
   name: string;
   email: string;
 }
 
 interface UserListProps {
   users: User[];
+  onDeleteUser: (id: number) => void;
 }
 
-export const UserList: React.FC<UserListProps> = ({ users }) => {
-  const deleteUser = (id: number) => {
-    // This should be implemented
-    console.log('Delete user:', id);
-  };
+export const UserList: React.FC<UserListProps> = ({ users, onDeleteUser }) => {
   return (
     <ul className="user-list">
       {users.map(user => (
         <li key={user.id} className="user-item">
           <span>{user.name} ({user.email})</span>
           <button onClick={() => deleteUser(user.id)}>
             Delete
           </button>
         </li>
       ))}
     </ul>
   );
 };`;

      const patchFile = path.join(tempDir, 'bug-fix.patch');
      fs.writeFileSync(patchFile, bugFixPatch);

      // Apply the patch
      const result = execSync(`"${GIT_PATH}" apply "${patchFile}"`, {
        cwd: repoDir,
        stdio: 'pipe'
      });

      // Verify the bug fix was applied
      const updatedApp = fs.readFileSync(path.join(repoDir, 'src/App.tsx'), 'utf8');
      expect(updatedApp).toContain('const [users, setUsers] = useState<User[]>([');

      const updatedUserList = fs.readFileSync(path.join(repoDir, 'src/components/UserList.tsx'), 'utf8');
      expect(updatedUserList).toContain('onDeleteUser: (id: number) => void');
      expect(updatedUserList).toContain('onDeleteUser(user.id)');
    });
  });

  describe('Error Recovery Scenarios', () => {
    it('should handle and recover from patch conflicts', () => {
      createProjectStructure();

      // Create a conflicting change first
      const conflictingChange = `--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -15,6 +15,6 @@ export const Button: React.FC<ButtonProps> = ({
 }) => {
   return (
     <button
-      className={\`btn \${className}\`}
+      className={\`btn btn-custom \${className}\`}
       disabled={disabled}
       onClick={onClick}
     >
       {children}
     </button>
   );
 };`;

      const conflictFile = path.join(tempDir, 'conflict.patch');
      fs.writeFileSync(conflictFile, conflictingChange);
      execSync(`git apply "${conflictFile}"`, { cwd: repoDir, stdio: 'ignore' });
      execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
      execSync('git commit -m "Conflicting change"', { cwd: repoDir, stdio: 'ignore' });

      // Now try to apply the original refactoring patch
      const refactorPatch = `--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -15,6 +15,6 @@ export const Button: React.FC<ButtonProps> = ({
 }) => {
   return (
     <button
-      className={\`btn \${className}\`}
+      className={\`btn btn-primary \${className}\`}
       disabled={disabled}
       onClick={onClick}
     >
       {children}
     </button>
   );
 };`;

      const refactorFile = path.join(tempDir, 'refactor.patch');
      fs.writeFileSync(refactorFile, refactorPatch);

      // This should fail due to conflict
      expect(() => {
        execSync(`git apply "${refactorFile}"`, { cwd: repoDir, stdio: 'pipe' });
      }).toThrow();

      // Test 3-way merge approach
      const result = execSync(`git apply --3way "${refactorFile}"`, {
        cwd: repoDir,
        stdio: 'pipe'
      });

      // Should have created conflict markers that need to be resolved
      const conflictedContent = fs.readFileSync(path.join(repoDir, 'src/components/Button.tsx'), 'utf8');
      expect(conflictedContent).toContain('<<<<<<<');
    });

    it('should handle partial patch application', () => {
      createProjectStructure();

      // Create a patch that modifies multiple files, one of which doesn't exist
      const partialPatch = `--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -15,6 +15,6 @@ export const Button: React.FC<ButtonProps> = ({
 }) => {
   return (
     <button
-      className={\`btn \${className}\`}
+      className={\`btn btn-updated \${className}\`}
       disabled={disabled}
       onClick={onClick}
     >
       {children}
     </button>
   );
 };

--- a/src/components/NonExistent.tsx
+++ b/src/components/NonExistent.tsx
@@ -0,0 +1,5 @@
+import React from 'react';
+
+export const NonExistent = () => {
+  return <div>This file does not exist</div>;
+};`;

      const patchFile = path.join(tempDir, 'partial.patch');
      fs.writeFileSync(patchFile, partialPatch);

      // Apply with reject file to handle partial application
      const result = execSync(`git apply --reject "${patchFile}"`, {
        cwd: repoDir,
        stdio: 'pipe'
      });

      // The existing file should be updated
      const updatedButton = fs.readFileSync(path.join(repoDir, 'src/components/Button.tsx'), 'utf8');
      expect(updatedButton).toContain('btn-updated');

      // A reject file should be created for the non-existent file
      expect(fs.existsSync(path.join(repoDir, 'src/components/NonExistent.tsx.rej'))).toBe(true);
    });
  });

  describe('Performance and Scale Tests', () => {
    it('should handle large project patches efficiently', () => {
      createProjectStructure();

      // Create many files to simulate a large project
      for (let i = 0; i < 100; i++) {
        const content = `export const Module${i} = {
  id: ${i},
  name: 'Module ${i}',
  value: Math.random() * 100
};`;
        fs.writeFileSync(path.join(repoDir, `src/modules/module${i}.ts`), content);
      }

      execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
      execSync('git commit -m "Add many modules"', { cwd: repoDir, stdio: 'ignore' });

      // Create a patch that modifies many files
      const largePatchLines = ['--- a/src/modules/module0.ts', '+++ b/src/modules/module0.ts', '@@ -1,4 +1,4 @@'];
      
      for (let i = 0; i < 100; i++) {
        if (i > 0) {
          largePatchLines.push(`--- a/src/modules/module${i}.ts`, `+++ b/src/modules/module${i}.ts`, '@@ -1,4 +1,4 @@');
        }
        largePatchLines.push(`-export const Module${i} = {`, `+export const Module${i} = {`, `  id: ${i},`, `-  name: 'Module ${i}',`, `+  name: 'Updated Module ${i}',`, `  value: Math.random() * 100`, `};`);
      }

      const largePatch = largePatchLines.join('\n');
      const patchFile = path.join(tempDir, 'large.patch');
      fs.writeFileSync(patchFile, largePatch);

      const startTime = Date.now();
      const result = execSync(`"${GIT_PATH}" apply "${patchFile}"`, {
        cwd: repoDir,
        stdio: 'pipe'
      });
      const duration = Date.now() - startTime;

      // Should complete within reasonable time (less than 5 seconds)
      expect(duration).toBeLessThan(5000);

      // Verify some files were updated
      const updatedModule = fs.readFileSync(path.join(repoDir, 'src/modules/module0.ts'), 'utf8');
      expect(updatedModule).toContain('Updated Module 0');
    });
  });
});
