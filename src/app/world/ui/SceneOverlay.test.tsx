// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SceneOverlay } from './SceneOverlay'

describe('SceneOverlay', () => {
  it('renders title, status word, children and fires onClose from the esc button', () => {
    const onClose = vi.fn()
    render(
      <SceneOverlay title="us-east-1 · N. Virginia" health="healthy" onClose={onClose}>
        <div>chips here</div>
      </SceneOverlay>,
    )
    expect(screen.getByText('us-east-1 · N. Virginia')).toBeInTheDocument()
    expect(screen.getByText('healthy')).toBeInTheDocument()
    expect(screen.getByText('chips here')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'esc' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('omits the status dot when health is undefined', () => {
    render(<SceneOverlay title="São Paulo" subtitle="client population" onClose={() => {}}>x</SceneOverlay>)
    expect(screen.queryByTestId('scene-ovl-dot')).not.toBeInTheDocument()
    expect(screen.getByText('client population')).toBeInTheDocument()
  })

  it('renders a dot for an explicit dotColor even without health', () => {
    render(<SceneOverlay title="São Paulo" dotColor="var(--kit-teal)" onClose={() => {}}>x</SceneOverlay>)
    expect(screen.getByTestId('scene-ovl-dot')).toBeInTheDocument()
  })

  it('renders the footer slot', () => {
    render(
      <SceneOverlay title="t" onClose={() => {}} footer={<button>enter ⏎</button>}>x</SceneOverlay>,
    )
    expect(screen.getByRole('button', { name: 'enter ⏎' })).toBeInTheDocument()
  })
})
