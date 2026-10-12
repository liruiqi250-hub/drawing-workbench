param([switch]$Probe,[string]$InputManifest)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
    $languages=@([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object {$_.LanguageTag})
    $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if($Probe){
        @{available=($null -ne $engine);languages=$languages;engine='Windows.Media.Ocr';error=$(if($null -eq $engine){'本机未安装适用的 Windows OCR 语言包。'}else{''})} | ConvertTo-Json -Compress
        exit 0
    }
    if($null -eq $engine){throw '本机未安装适用的 Windows OCR 语言包，请在 Windows 语言设置中添加文字识别组件。'}
    $asTask=@([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]
    function Wait-WinRt($operation,[Type]$resultType){
        $task=$asTask.MakeGenericMethod($resultType).Invoke($null,@($operation))
        $task.GetAwaiter().GetResult()
    }
    $null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
    $null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
    $null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
    $items=@(ConvertFrom-Json ([IO.File]::ReadAllText($InputManifest)))
    if($items.Count -gt 30){throw 'OCR 单次页面数量超过上限。'}
    $output=@()
    foreach($item in $items){
        $stream=$null;$bitmap=$null
        try {
            $imagePath=[IO.Path]::GetFullPath([string]$item.path)
            if([IO.Path]::GetExtension($imagePath) -ne '.png'){throw 'OCR 只接受本机 PNG 缓存。'}
            $file=Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
            $stream=Wait-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
            $decoder=Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap=Wait-WinRt ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
            if($bitmap.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $bitmap.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension){throw 'OCR 页面像素超过本机引擎上限。'}
            $recognized=Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $output+=@{page=[int]$item.page;text=($recognized.Lines.Text -join "`n");error=''}
        } catch {$output+=@{page=[int]$item.page;text='';error=$_.Exception.Message}}
        finally {if($bitmap){$bitmap.Dispose()};if($stream){$stream.Dispose()}}
    }
    @{available=$true;languages=$languages;engine='Windows.Media.Ocr';pages=$output} | ConvertTo-Json -Depth 5 -Compress
} catch {
    @{available=$false;languages=@();engine='Windows.Media.Ocr';error=$_.Exception.Message;pages=@()} | ConvertTo-Json -Depth 5 -Compress
}
