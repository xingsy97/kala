import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Dialog, DialogContent, DialogTitle } from './dialog.js'

describe('Dialog motion classes', () => {
  it('uses shared motion classes for overlay and content', () => {
    render(
      <Dialog open>
        <DialogContent data-testid="dialog-content">
          <DialogTitle>Dialog title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(screen.getByTestId('dialog-content').className).toContain('ak-motion-dialog')
    const overlay = document.querySelector('.ak-drawer-overlay')
    expect(overlay?.className ?? '').toContain('ak-drawer-overlay')
  })
})
