# Covelet 品牌资产

Covelet采用本项目原创的C形海湾标记：C的开口与内部波形组成海湾意象。基础图形直接以SVG路径绘制，不含第三方品牌图形或下载字体；不把原创设计表述为已注册商标、通过名称排查或获得第三方背书。

## 源文件

| 文件 | 用途 |
| --- | --- |
| [covelet-mark.svg](covelet-mark.svg) | 256视图的单色标记，颜色`#176D7F`，适合独立展示 |
| [covelet-icon.svg](covelet-icon.svg) | 栅格输出主源；圆角底、深海蓝至青绿渐变（`#164E72`→`#149D98`）、浅色C形标记 |
| [covelet-promo.svg](covelet-promo.svg) | 440×280宣传图的生成结果，含Covelet及“A quiet place to start.”文字 |

`covelet-icon.svg`为PNG生成器读取的主源。单色标记不会自动同步回主源；改变轮廓时应同步调整两份SVG。宣传图SVG由脚本覆盖生成，布局和文案应修改脚本中的`promotion`函数。

## 当前输出

- 扩展图标：`app/public/icons/icon-16.png`、`icon-32.png`、`icon-48.png`、`icon-128.png`。
- 大图预览：[covelet-icon-512.png](covelet-icon-512.png)。
- 商店图标：`docs/store/assets/chrome-logo-128.png`（96×96主体，四边各16px透明留白）、`edge-logo-300.png`。
- 宣传图：`docs/store/assets/promo-440x280.png`、`promo-1400x560.png`。

这些品牌输出不包含Bing照片；商店实际页面截图另行捕获并核对素材权利与尺寸。各商店所需规格见[提交材料](../store/商店提交材料.md)。

## 重建

在`app`目录执行：

```powershell
node scripts/generate-brand-assets.mjs
```

该作者工具需要可信环境中的`sharp`。正常构建直接使用已保存的PNG，不要求临时安装图像工具；如`sharp`位于独立工具环境，可让环境变量`COVELET_SHARP_PATH`指向其可信包入口后运行同一命令。脚本不调用远程图像服务或字体服务，宣传图文字由当前环境的Arial／sans-serif渲染。

脚本会覆盖上列PNG及`covelet-promo.svg`，不会修改手绘SVG主源。重建后需检查小尺寸辨识度、透明边缘、明暗底和宣传图文字；本记录不代替最终商店图像／UI QA。实际输出已生成并目视检查，商店图标与两种宣传图已上传。
