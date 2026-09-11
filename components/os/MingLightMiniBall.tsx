import React, {
  useCallback,
  useRef,
  useState,
} from 'react';

import {
  BookOpen,
  X,
} from '@phosphor-icons/react';

import { useOS } from '../../context/OSContext';
import { AppID } from '../../types';
import { subscribeMingLightBridge, getMingLightLastBook } from '../../utils/mingLightBridge';

const MingLightMiniBall: React.FC = () => {
  const {
    openApp,
    closeApp,
  } = useOS();

  const [visible, setVisible] =
    useState(false);

  const [position, setPosition] =
    useState({
      x: 24,
      y: 180,
    });

  const dragging =
    useRef(false);

  const dragStart =
    useRef({
      x: 0,
      y: 0,
      startX: 0,
      startY: 0,
    });

  const handlePointerDown =
    useCallback(
      (
        e: React.PointerEvent<HTMLButtonElement>
      ) => {
        dragging.current = true;

        dragStart.current = {
          x: e.clientX,
          y: e.clientY,
          startX: position.x,
          startY: position.y,
        };

        e.currentTarget.setPointerCapture(
          e.pointerId
        );
      },
      [position]
    );

  const handlePointerMove =
    useCallback(
      (
        e: React.PointerEvent<HTMLButtonElement>
      ) => {
        if (
          !dragging.current
        ) {
          return;
        }

        const dx =
          e.clientX -
          dragStart.current.x;

        const dy =
          e.clientY -
          dragStart.current.y;

        setPosition({
          x: Math.max(
            8,
            Math.min(
              window.innerWidth -
                64,
              dragStart.current.startX +
                dx
            )
          ),

          y: Math.max(
            72,
            Math.min(
              window.innerHeight -
                72,
              dragStart.current.startY +
                dy
            )
          ),
        });
      },
      []
    );

  const handlePointerUp =
    useCallback(() => {
      dragging.current = false;
    }, []);

  const handleClick =
    useCallback(() => {
      if (
        dragging.current
      ) {
        return;
      }

      openApp?.(AppID.Reading);
      setVisible(false);
    }, [openApp]);

  // 眠光那边点了「缩小」按钮时，冒出这个球；
  // 眠光正常打开/关闭时，球要让开，不重叠显示。
  React.useEffect(() => {
    const unsub = subscribeMingLightBridge((event) => {
      if (event === 'minimized') setVisible(true);
      if (event === 'opened' || event === 'closed') setVisible(false);
    });
    return unsub;
  }, []);

  if (!visible || !getMingLightLastBook()) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onPointerDown={
          handlePointerDown
        }
        onPointerMove={
          handlePointerMove
        }
        onPointerUp={
          handlePointerUp
        }
        onClick={
          handleClick
        }
        className="fixed z-[9999] w-14 h-14 rounded-full shadow-xl flex items-center justify-center select-none touch-none"
        style={{
          left: position.x,
          top: position.y,
          background:
            'rgba(245, 236, 220, 0.96)',
          color: '#73563B',
          border:
            '1px solid rgba(115, 86, 59, 0.18)',
        }}
        aria-label="打开眠光"
      >
        <BookOpen size={24} />
      </button>

      <button
        type="button"
        onClick={() => {
          setVisible(false);
          closeApp?.();
        }}
        className="fixed z-[10000] flex items-center justify-center w-5 h-5 rounded-full bg-black/55 text-white"
        style={{
          left: position.x + 40,
          top: position.y - 4,
        }}
        aria-label="关闭眠光悬浮球"
      >
        <X size={11} />
      </button>
    </>
  );
};

export default MingLightMiniBall;
