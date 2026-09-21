import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProductPage, ProductPageBody, ProductPageHeader, ProductPanel, ProductSegment, ProductSegmentedControl } from './product-page.js'

describe('product page primitives', () => {
  it('builds one consistent page, header, panel, and segmented navigation hierarchy', () => {
    const select = vi.fn()
    render(
      <ProductPage testId="page">
        <ProductPageHeader title="Operations" description="Runtime evidence" actions={<ProductSegmentedControl label="Views"><ProductSegment active onClick={select}>Diagnostics</ProductSegment><ProductSegment active={false} onClick={() => {}}>Profiles</ProductSegment></ProductSegmentedControl>} />
        <ProductPageBody><ProductPanel testId="panel">Content</ProductPanel></ProductPageBody>
      </ProductPage>,
    )
    expect(screen.getByTestId('page').className).toContain('ak-workspace-canvas')
    expect(screen.getByTestId('panel').className).toContain('ak-workspace-surface')
    expect(screen.getByRole('group', { name: 'Views' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))
    expect(select).toHaveBeenCalledOnce()
  })

  it('keeps inactive panels mounted but hidden', () => {
    render(<ProductPanel active={false} testId="panel">Preserved state</ProductPanel>)
    expect(screen.getByTestId('panel').className).toContain('hidden')
    expect(screen.getByText('Preserved state')).toBeTruthy()
  })

  it('can hide the product eyebrow for focused pages', () => {
    render(<ProductPageHeader eyebrow={null} title="Memo" titleTestId="memo-title" />)
    expect(screen.getByTestId('memo-title').textContent).toBe('Memo')
    expect(screen.queryByText('Kala')).toBeNull()
  })
})
