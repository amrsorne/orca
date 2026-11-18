import { mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameFileWithWindowsRetryAsync } from '../../shared/file-write/windows-retry-file-operations'
import { restrictWindowsFile } from '../../shared/secure-storage/secure-path-windows-acl'
import { loadWindowsSecurity } from '../../shared/secure-storage/windows-security-addon'
import { durableWriteTempPath, syncDirectory } from './durable-file-write'

/** The async counterpart of writeSecureFile: the contents only ever land in a file other users can't
 *  read (0o600, or an owner-only DACL on Windows; without the Windows addon, a plain write as there).
 *  False when `isCurrent` vetoed it; throws, writing nothing, when the DACL can't be set. */
export async function writeOwnerOnlyFileDurableIfCurrent(
  finalPath: string,
  contents: string,
  isCurrent: () => boolean
): Promise<boolean> {
  await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 })
  const tmpPath = durableWriteTempPath(finalPath)
  const windows = process.platform === 'win32'
  let renamed = false
  try {
    if (windows) {
      // Restricted while still empty, so no reader ever sees the contents under an inherited DACL.
      await (await open(tmpPath, 'wx', 0o600)).close()
      if (!(await restrictWindowsFile(tmpPath)) && !('error' in loadWindowsSecurity())) {
        throw new Error(`Could not restrict ${tmpPath} to its owner`)
      }
    }
    const handle = await open(tmpPath, windows ? 'r+' : 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!(await renameFileWithWindowsRetryAsync(tmpPath, finalPath, isCurrent))) {
      return false
    }
    renamed = true
    await syncDirectory(dirname(finalPath))
    return true
  } finally {
    if (!renamed) {
      await rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}
