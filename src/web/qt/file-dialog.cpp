// SPDX-License-Identifier: GPL-2.0-or-later

#include <algorithm>
#include <QMessageBox>
#include <QPointer>
#include <QProgressDialog>
#include <QTimer>
#include <emscripten.h>
#include <emscripten/val.h>
#include "web/qt/file-dialog.h"

namespace {

EM_JS(bool, BeginGameImport, (const char* accept), {
    return Module["azaharQtRuntime"].beginGameImport(UTF8ToString(accept));
});

EM_JS(emscripten::EM_VAL, GameImportStatus, (), {
    return Emval.toHandle(Module["azaharQtRuntime"].gameImportStatus());
});

EM_JS(void, CancelGameImport, (), {
    Module["azaharQtRuntime"].cancelGameImport();
});

EM_JS(void, FinishGameImport, (), {
    Module["azaharQtRuntime"].finishGameImport();
});

} // namespace

namespace Web::Qt {

void OpenGameFile(QWidget* parent, const QStringList& extensions,
                  std::function<void(const QString&)> completed) {
    QStringList accept;
    for (const auto& extension : extensions) {
        accept.append(QStringLiteral(".") + extension);
    }
    if (!BeginGameImport(accept.join(QStringLiteral(",")).toUtf8().constData())) {
        completed({});
        return;
    }
    auto* progress = new QProgressDialog(
        QObject::tr("Importing game…"), QObject::tr("Cancel"), 0, 1000, parent);
    progress->setWindowTitle(QObject::tr("Load File"));
    progress->setWindowModality(::Qt::WindowModal);
    progress->setMinimumDuration(250);
    progress->setAutoClose(false);
    progress->setAutoReset(false);
    // Start the progress timer only after the browser picker has supplied a file.
    progress->reset();
    QObject::connect(progress, &QProgressDialog::canceled, [] { CancelGameImport(); });
    QObject::connect(progress, &QObject::destroyed, [] { CancelGameImport(); });

    auto* timer = new QTimer(progress);
    const QPointer<QWidget> owner(parent);
    QObject::connect(timer, &QTimer::timeout, progress, [=] {
        const auto status = emscripten::val::take_ownership(GameImportStatus());
        if (!status["done"].as<bool>()) {
            const auto fraction = status["progress"].as<double>();
            if (fraction >= 0 && !progress->wasCanceled()) {
                progress->setValue(static_cast<int>(std::clamp(fraction, 0.0, 1.0) * 1000));
            }
            return;
        }
        timer->stop();
        const auto path = QString::fromStdString(status["path"].as<std::string>());
        const auto error = QString::fromStdString(status["error"].as<std::string>());
        FinishGameImport();
        QObject::disconnect(progress, nullptr, nullptr, nullptr);
        progress->deleteLater();
        if (!owner) return;
        QTimer::singleShot(0, owner, [=] {
            if (!error.isEmpty()) {
                QMessageBox::critical(owner, QObject::tr("Load File"), error.toHtmlEscaped());
            }
            completed(path);
        });
    });
    timer->start(50);
}

} // namespace Web::Qt
